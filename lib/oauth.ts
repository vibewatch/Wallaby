import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import type { OAuthClient, Prisma } from "@prisma/client";

import { db } from "@/lib/db";
import { verifyPasswordCredentials } from "@/lib/password-auth";

export const oauthGrantTypes = ["password", "refresh_token", "authorization_code", "token"] as const;
export type OAuthGrantType = typeof oauthGrantTypes[number];

const accessTokenLifetimeSeconds = 3_600;
const refreshTokenLifetimeSeconds = 30 * 24 * 60 * 60;
const authorizationCodeLifetimeSeconds = 10 * 60;

type TokenPayload = {
  access_token: string;
  expires_in: number;
  token_type: "bearer";
  refresh_token?: string;
  scope: string | null;
};

export async function createOAuthClient(input: {
  userId: string;
  name: string;
  redirectUris: string[];
  allowedGrantTypes: string[];
}): Promise<{ client: OAuthClient; clientId: string; clientSecret: string }> {
  const name = input.name.trim();
  if (!name || name.length > 100) throw new Error("Client name must contain 1 to 100 characters");
  const redirectUris = normalizeRedirectUris(input.redirectUris);
  const allowedGrantTypes = normalizeGrantTypes(input.allowedGrantTypes);
  const clientId = `wby_client_${randomBytes(18).toString("base64url")}`;
  const clientSecret = randomBytes(32).toString("base64url");
  const client = await db.oAuthClient.create({
    data: { userId: input.userId, publicId: clientId, name, secretHash: hashToken(clientSecret), redirectUris, allowedGrantTypes },
  });
  return { client, clientId, clientSecret };
}

export async function handleOAuthTokenRequest(request: Request): Promise<Response> {
  try {
    const params = await oauthRequestParameters(request);
    const credentials = clientCredentials(request, params);
    const client = await authenticateOAuthClient(credentials.clientId, credentials.clientSecret);
    const grantType = requiredParameter(params, "grant_type") as OAuthGrantType;
    if (!oauthGrantTypes.includes(grantType)) throw oauthError("unsupported_grant_type", "The requested grant type is not supported");
    requireGrant(client, grantType);
    let payload: TokenPayload;
    if (grantType === "password") payload = await passwordGrant(client, params, request.headers);
    else if (grantType === "refresh_token") payload = await refreshTokenGrant(client, params);
    else if (grantType === "authorization_code") payload = await authorizationCodeGrant(client, params);
    else throw oauthError("unsupported_grant_type", "The implicit token grant is available only through /oauth/v2/auth");
    return tokenResponse(payload);
  } catch (error) {
    return oauthErrorResponse(error);
  }
}

export type OAuthAuthorizationInput = {
  clientId: string;
  redirectUri: string;
  responseType: "code" | "token";
  state?: string;
  scope?: string;
  codeChallenge?: string;
  codeChallengeMethod?: "plain" | "S256";
};

export async function getOAuthAuthorizationContext(input: OAuthAuthorizationInput): Promise<{
  client: Pick<OAuthClient, "id" | "name" | "publicId">;
  redirectUri: string;
  responseType: "code" | "token";
  state?: string;
  scope: string | null;
  codeChallenge?: string;
  codeChallengeMethod?: "plain" | "S256";
}> {
  const client = await db.oAuthClient.findUnique({ where: { publicId: input.clientId }, select: { id: true, name: true, publicId: true, redirectUris: true, allowedGrantTypes: true } });
  if (!client) throw oauthError("invalid_request", "Unknown OAuth client");
  const redirectUri = validateClientRedirect(client.redirectUris, input.redirectUri);
  const requiredGrant: OAuthGrantType = input.responseType === "code" ? "authorization_code" : "token";
  if (!jsonStringArray(client.allowedGrantTypes).includes(requiredGrant)) throw oauthError("unauthorized_client", "This client cannot use the requested response type");
  const state = optionalBounded(input.state, 500, "state");
  const scope = normalizeScope(input.scope);
  const codeChallenge = optionalBounded(input.codeChallenge, 128, "code_challenge");
  let codeChallengeMethod = input.codeChallengeMethod;
  if (codeChallenge) {
    codeChallengeMethod ??= "plain";
    if (codeChallenge.length < 43) throw oauthError("invalid_request", "code_challenge must contain at least 43 characters");
    if (codeChallengeMethod !== "plain" && codeChallengeMethod !== "S256") throw oauthError("invalid_request", "Unsupported code_challenge_method");
  } else if (codeChallengeMethod) {
    throw oauthError("invalid_request", "code_challenge_method requires code_challenge");
  }
  return { client, redirectUri, responseType: input.responseType, state, scope, codeChallenge, codeChallengeMethod };
}

export async function completeOAuthAuthorization(userId: string, input: OAuthAuthorizationInput & { approved: boolean }): Promise<string> {
  const context = await getOAuthAuthorizationContext(input);
  const destination = new URL(context.redirectUri);
  if (!input.approved) {
    destination.searchParams.set("error", "access_denied");
    if (context.state) destination.searchParams.set("state", context.state);
    return destination.toString();
  }
  if (context.responseType === "code") {
    const code = `wby_code_${randomBytes(32).toString("base64url")}`;
    await db.oAuthAuthorizationCode.create({
      data: {
        clientId: context.client.id,
        userId,
        codeHash: hashToken(code),
        redirectUri: context.redirectUri,
        scope: context.scope,
        codeChallenge: context.codeChallenge,
        codeChallengeMethod: context.codeChallengeMethod,
        expiresAt: new Date(Date.now() + authorizationCodeLifetimeSeconds * 1_000),
      },
    });
    destination.searchParams.set("code", code);
    if (context.state) destination.searchParams.set("state", context.state);
    return destination.toString();
  }
  const access = await db.$transaction((transaction) => issueAccessToken(transaction, context.client.id, userId, context.scope));
  const fragment = new URLSearchParams({
    access_token: access.token,
    token_type: "bearer",
    expires_in: String(accessTokenLifetimeSeconds),
  });
  if (context.scope) fragment.set("scope", context.scope);
  if (context.state) fragment.set("state", context.state);
  destination.hash = fragment.toString();
  return destination.toString();
}

export async function authenticateOAuthAccessToken(rawToken: string): Promise<string | null> {
  if (!rawToken.startsWith("wby_oauth_")) return null;
  const token = await db.oAuthAccessToken.findUnique({ where: { tokenHash: hashToken(rawToken) } });
  if (!token || token.expiresAt <= new Date()) return null;
  await db.oAuthAccessToken.update({ where: { id: token.id }, data: { lastUsedAt: new Date() } });
  return token.userId;
}

async function passwordGrant(client: OAuthClient, params: URLSearchParams, headers: Headers): Promise<TokenPayload> {
  const username = requiredParameter(params, "username");
  const password = requiredParameter(params, "password");
  const verification = await verifyPasswordCredentials(username, password, headers);
  if (verification.status === "limited") throw oauthError("temporarily_unavailable", "Too many resource-owner authentication attempts", 429);
  if (verification.status !== "authenticated") throw oauthError("invalid_grant", "The resource owner credentials are invalid");
  const user = verification.user;
  if (user.twoFactorMethod !== "NONE") throw oauthError("invalid_grant", "Password grants are disabled for accounts with two-factor authentication; use the authorization-code grant");
  return db.$transaction((transaction) => issueTokenPair(transaction, client.id, user.id, normalizeScope(params.get("scope") ?? undefined)));
}

async function refreshTokenGrant(client: OAuthClient, params: URLSearchParams): Promise<TokenPayload> {
  const rawToken = requiredParameter(params, "refresh_token");
  const record = await db.oAuthRefreshToken.findUnique({ where: { tokenHash: hashToken(rawToken) } });
  if (!record || record.clientId !== client.id || record.expiresAt <= new Date()) throw oauthError("invalid_grant", "The refresh token is invalid or expired");
  const requestedScope = params.get("scope") ? normalizeScope(params.get("scope") ?? undefined) : record.scope;
  if (requestedScope && record.scope && !isScopeSubset(requestedScope, record.scope)) throw oauthError("invalid_scope", "The refreshed scope may not exceed the original grant");
  return db.$transaction(async (transaction) => {
    const consumed = await transaction.oAuthRefreshToken.deleteMany({ where: { id: record.id, tokenHash: record.tokenHash } });
    if (consumed.count !== 1) throw oauthError("invalid_grant", "The refresh token was already used");
    return issueTokenPair(transaction, client.id, record.userId, requestedScope);
  });
}

async function authorizationCodeGrant(client: OAuthClient, params: URLSearchParams): Promise<TokenPayload> {
  const rawCode = requiredParameter(params, "code");
  const redirectUri = requiredParameter(params, "redirect_uri");
  const code = await db.oAuthAuthorizationCode.findUnique({ where: { codeHash: hashToken(rawCode) } });
  if (!code || code.clientId !== client.id || code.redirectUri !== redirectUri || code.usedAt || code.expiresAt <= new Date()) {
    throw oauthError("invalid_grant", "The authorization code is invalid, expired, or already used");
  }
  if (code.codeChallenge) {
    const verifier = requiredParameter(params, "code_verifier");
    if (verifier.length < 43 || verifier.length > 128 || !verifyCodeChallenge(verifier, code.codeChallenge, code.codeChallengeMethod)) {
      throw oauthError("invalid_grant", "PKCE verification failed");
    }
  }
  return db.$transaction(async (transaction) => {
    const consumed = await transaction.oAuthAuthorizationCode.updateMany({ where: { id: code.id, usedAt: null }, data: { usedAt: new Date() } });
    if (consumed.count !== 1) throw oauthError("invalid_grant", "The authorization code was already used");
    return issueTokenPair(transaction, client.id, code.userId, code.scope);
  });
}

async function issueTokenPair(transaction: Prisma.TransactionClient, clientId: string, userId: string, scope: string | null): Promise<TokenPayload> {
  const access = await issueAccessToken(transaction, clientId, userId, scope);
  const refreshToken = `wby_refresh_${randomBytes(32).toString("base64url")}`;
  await transaction.oAuthRefreshToken.create({
    data: { clientId, userId, tokenHash: hashToken(refreshToken), scope, expiresAt: new Date(Date.now() + refreshTokenLifetimeSeconds * 1_000) },
  });
  return { access_token: access.token, expires_in: accessTokenLifetimeSeconds, token_type: "bearer", refresh_token: refreshToken, scope };
}

async function issueAccessToken(transaction: Prisma.TransactionClient, clientId: string, userId: string, scope: string | null) {
  const token = `wby_oauth_${randomBytes(32).toString("base64url")}`;
  await transaction.oAuthAccessToken.create({
    data: { clientId, userId, tokenHash: hashToken(token), scope, expiresAt: new Date(Date.now() + accessTokenLifetimeSeconds * 1_000) },
  });
  return { token };
}

async function authenticateOAuthClient(clientId: string, clientSecret: string): Promise<OAuthClient> {
  const client = await db.oAuthClient.findUnique({ where: { publicId: clientId } });
  if (!client || !safeEqual(client.secretHash, hashToken(clientSecret))) throw oauthError("invalid_client", "Client authentication failed", 401);
  return client;
}

function requireGrant(client: OAuthClient, grantType: OAuthGrantType): void {
  if (!jsonStringArray(client.allowedGrantTypes).includes(grantType)) throw oauthError("unauthorized_client", "This client cannot use the requested grant type");
}

async function oauthRequestParameters(request: Request): Promise<URLSearchParams> {
  if (request.method === "GET") return new URL(request.url).searchParams;
  const contentType = request.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
  if (contentType === "application/json") {
    const payload = await request.json().catch(() => null) as unknown;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw oauthError("invalid_request", "The JSON request body is invalid");
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(payload)) if (typeof value === "string") params.set(key, value);
    return params;
  }
  const form = await request.formData().catch(() => null);
  if (!form) throw oauthError("invalid_request", "The form request body is invalid");
  const params = new URLSearchParams();
  for (const [key, value] of form) if (typeof value === "string") params.set(key, value);
  return params;
}

function clientCredentials(request: Request, params: URLSearchParams): { clientId: string; clientSecret: string } {
  const authorization = request.headers.get("authorization");
  if (authorization?.startsWith("Basic ")) {
    try {
      const decoded = Buffer.from(authorization.slice(6), "base64").toString("utf8");
      const separator = decoded.indexOf(":");
      if (separator > 0) return { clientId: decodeURIComponent(decoded.slice(0, separator)), clientSecret: decodeURIComponent(decoded.slice(separator + 1)) };
    } catch { /* The standard invalid-client response below is sufficient. */ }
  }
  return { clientId: requiredParameter(params, "client_id"), clientSecret: requiredParameter(params, "client_secret") };
}

function normalizeRedirectUris(values: string[]): string[] {
  const normalized = [...new Set(values.map((value) => value.trim()).filter(Boolean))];
  if (!normalized.length || normalized.length > 10) throw new Error("Provide between one and ten redirect URLs");
  return normalized.map((value) => {
    if (value.length > 2_000) throw new Error("Redirect URLs are limited to 2,000 characters");
    const url = new URL(value);
    if (!/^[a-z][a-z0-9+.-]*:$/.test(url.protocol) || ["javascript:", "data:", "file:"].includes(url.protocol) || url.username || url.password || url.hash) {
      throw new Error("Redirect URLs must use a safe absolute URL without credentials or fragments");
    }
    return url.toString();
  });
}

function normalizeGrantTypes(values: string[]): OAuthGrantType[] {
  const grants = [...new Set(values.map((value) => value.trim()))];
  if (!grants.length || grants.some((grant) => !oauthGrantTypes.includes(grant as OAuthGrantType))) throw new Error("Choose at least one supported OAuth grant type");
  return grants as OAuthGrantType[];
}

function validateClientRedirect(value: Prisma.JsonValue, requested: string): string {
  let normalized: string;
  try { normalized = new URL(requested).toString(); }
  catch { throw oauthError("invalid_request", "redirect_uri is invalid"); }
  if (!jsonStringArray(value).includes(normalized)) throw oauthError("invalid_request", "redirect_uri is not registered for this client");
  return normalized;
}

function normalizeScope(value: string | undefined): string | null {
  if (!value?.trim()) return null;
  const scope = [...new Set(value.trim().split(/\s+/))].join(" ");
  if (scope.length > 500 || /[^\x21\x23-\x5B\x5D-\x7E ]/.test(scope)) throw oauthError("invalid_scope", "The requested scope is invalid");
  return scope;
}

function isScopeSubset(requested: string, allowed: string): boolean {
  const available = new Set(allowed.split(" "));
  return requested.split(" ").every((scope) => available.has(scope));
}

function verifyCodeChallenge(verifier: string, challenge: string, method: string | null): boolean {
  const actual = method === "S256" ? createHash("sha256").update(verifier).digest("base64url") : verifier;
  return safeEqual(actual, challenge);
}

function requiredParameter(params: URLSearchParams, name: string): string {
  const value = params.get(name)?.trim();
  if (!value) throw oauthError("invalid_request", `Missing ${name}`);
  if (value.length > 2_000) throw oauthError("invalid_request", `${name} is too long`);
  return value;
}

function optionalBounded(value: string | undefined, maximum: number, name: string): string | undefined {
  if (!value) return undefined;
  if (value.length > maximum) throw oauthError("invalid_request", `${name} is too long`);
  return value;
}

function jsonStringArray(value: Prisma.JsonValue): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function safeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

class OAuthRequestError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400) { super(message); }
}

function oauthError(code: string, message: string, status = 400): OAuthRequestError {
  return new OAuthRequestError(code, message, status);
}

function oauthErrorResponse(error: unknown): Response {
  const failure = error instanceof OAuthRequestError ? error : oauthError("server_error", "The authorization server could not complete the request", 500);
  return Response.json({ error: failure.code, error_description: failure.message }, {
    status: failure.status,
    headers: {
      "Cache-Control": "no-store",
      Pragma: "no-cache",
      ...(failure.status === 401 ? { "WWW-Authenticate": 'Basic realm="Wallaby OAuth"' } : {}),
    },
  });
}

function tokenResponse(payload: TokenPayload): Response {
  return Response.json(payload, { headers: { "Cache-Control": "no-store", Pragma: "no-cache" } });
}
