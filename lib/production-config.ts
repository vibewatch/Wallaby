type Environment = Record<string, string | undefined>;

export class ProductionConfigurationError extends Error {
  readonly issues: string[];

  constructor(issues: string[]) {
    super(`Invalid production configuration:\n- ${issues.join("\n- ")}`);
    this.name = "ProductionConfigurationError";
    this.issues = issues;
  }
}

export function validateProductionEnvironment(env: Environment = process.env): { warnings: string[] } {
  const issues: string[] = [];
  const warnings: string[] = [];
  const authSecret = value(env, "AUTH_SECRET");
  if (!authSecret || authSecret.length < 32 || looksLikePlaceholder(authSecret)) {
    issues.push("AUTH_SECRET must be a non-placeholder secret containing at least 32 characters");
  }

  const databaseUrl = value(env, "DATABASE_URL");
  if (!databaseUrl) issues.push("DATABASE_URL is required");
  else if (/^postgres(?:ql)?:/.test(databaseUrl)) {
    try {
      const url = new URL(databaseUrl);
      if (!url.hostname || !url.username || !url.password || url.pathname.length < 2) throw new Error();
    } catch {
      issues.push("DATABASE_URL must be a valid PostgreSQL URL with host, database, username and password");
    }
    if (env.DATABASE_PROVIDER && env.DATABASE_PROVIDER !== "postgresql") issues.push("DATABASE_URL does not match this image's DATABASE_PROVIDER");
  } else if (databaseUrl.startsWith("file:")) {
    if (env.DATABASE_PROVIDER && env.DATABASE_PROVIDER !== "sqlite") issues.push("DATABASE_URL does not match this image's DATABASE_PROVIDER");
    const databasePath = databaseUrl.slice(5).split("?", 1)[0];
    if (!databasePath || /(?:^|\/)dev\.db$/i.test(databasePath)) issues.push("DATABASE_URL must not point at the development database in production");
    else if (!databasePath.startsWith("/")) warnings.push("DATABASE_URL uses a relative SQLite path; mount and back up that working directory explicitly");
  } else issues.push("DATABASE_URL must use a PostgreSQL URL or SQLite file: protocol");

  for (const name of ["SITE_CREDENTIALS_KEY", "TWO_FACTOR_KEY", "POCKET_TOKEN_KEY"] as const) {
    const configured = value(env, name);
    if (configured && !isBase64Key(configured, [32])) issues.push(`${name} must be a base64-encoded 32-byte key`);
  }
  const actionKey = value(env, "NEXT_SERVER_ACTIONS_ENCRYPTION_KEY");
  if (actionKey && !isBase64Key(actionKey, [16, 24, 32])) {
    issues.push("NEXT_SERVER_ACTIONS_ENCRYPTION_KEY must be a base64-encoded 16, 24, or 32-byte key");
  }

  const authUrl = value(env, "AUTH_URL");
  if (authUrl) validatePublicUrl(authUrl, issues);
  validateBoolean(env, "WALLABY_BOT_PROFILES", issues);
  validateBoolean(env, "WALLABY_BROWSER_RENDER", issues);
  validateSmtp(env, issues);

  if (issues.length) throw new ProductionConfigurationError(issues);
  return { warnings };
}

function validatePublicUrl(input: string, issues: string[]): void {
  try {
    const url = new URL(input);
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error();
    const local = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1";
    if (url.protocol !== "https:" && !local) issues.push("AUTH_URL must use HTTPS outside localhost");
    if (url.pathname !== "/" || url.username || url.password || url.search || url.hash) {
      issues.push("AUTH_URL must be a clean public origin without path, credentials, query, or fragment");
    }
  } catch {
    issues.push("AUTH_URL must be a valid HTTP(S) URL when provided");
  }
}

function validateBoolean(env: Environment, name: string, issues: string[]): void {
  const configured = value(env, name)?.toLowerCase();
  if (configured && !["1", "0", "true", "false", "yes", "no", "on", "off"].includes(configured)) {
    issues.push(`${name} must be a recognized boolean value`);
  }
}

function validateSmtp(env: Environment, issues: string[]): void {
  const names = ["TWO_FACTOR_SMTP_HOST", "TWO_FACTOR_SMTP_PORT", "TWO_FACTOR_SMTP_SECURITY", "TWO_FACTOR_SMTP_USER", "TWO_FACTOR_SMTP_PASSWORD", "TWO_FACTOR_EMAIL_FROM"] as const;
  if (!names.some((name) => value(env, name))) return;
  if (!value(env, "TWO_FACTOR_SMTP_HOST")) issues.push("TWO_FACTOR_SMTP_HOST is required when email two-factor settings are present");
  if (!value(env, "TWO_FACTOR_EMAIL_FROM")) issues.push("TWO_FACTOR_EMAIL_FROM is required when email two-factor settings are present");
  const port = value(env, "TWO_FACTOR_SMTP_PORT");
  if (port && (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65_535)) issues.push("TWO_FACTOR_SMTP_PORT must be an integer from 1 to 65535");
  const security = value(env, "TWO_FACTOR_SMTP_SECURITY")?.toLowerCase();
  if (security && !["tls", "starttls", "none"].includes(security)) issues.push("TWO_FACTOR_SMTP_SECURITY must be tls, starttls, or none");
  if (Boolean(value(env, "TWO_FACTOR_SMTP_USER")) !== Boolean(value(env, "TWO_FACTOR_SMTP_PASSWORD"))) {
    issues.push("TWO_FACTOR_SMTP_USER and TWO_FACTOR_SMTP_PASSWORD must be provided together");
  }
}

function isBase64Key(input: string, byteLengths: number[]): boolean {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(input) || input.length % 4 !== 0) return false;
  try { return byteLengths.includes(Buffer.from(input, "base64").length); }
  catch { return false; }
}

function looksLikePlaceholder(input: string): boolean {
  return /replace[-_ ]?with|change[-_ ]?me|example|placeholder/i.test(input);
}

function value(env: Environment, name: string): string | undefined {
  return env[name]?.trim() || undefined;
}
