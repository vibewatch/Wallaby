import { createOAuthClient, oauthGrantTypes } from "../lib/oauth";
import { findCliUser } from "../lib/cli-operations";
import { db } from "../lib/db";
import { parseCliArgs } from "./cli-args";

const args = parseCliArgs();
const [identifier] = args.positionals;

try {
  if (!identifier) throw new Error("Usage: npm run oauth:create-client -- <username> --redirect-uri=https://client.example/callback [--display-name=Name] [--grant-types=authorization_code,refresh_token] [--format=text|env|json]");
  const redirectUris = [args.options.get("redirect-uri"), ...(args.options.get("redirect-uris")?.split(",") ?? [])].filter((value): value is string => Boolean(value));
  const grants = (args.options.get("grant-types") ?? "authorization_code,refresh_token,password,token").split(",").map((value) => value.trim()).filter((value) => oauthGrantTypes.includes(value as typeof oauthGrantTypes[number]));
  const user = await findCliUser(identifier);
  const created = await createOAuthClient({ userId: user.id, name: args.options.get("display-name") ?? "Default client", redirectUris, allowedGrantTypes: grants });
  const output = { client_id: created.clientId, client_secret: created.clientSecret, owner: user.username, redirect_uris: redirectUris, grant_types: grants };
  const format = args.options.get("format") ?? "text";
  if (format === "json") console.info(JSON.stringify(output));
  else if (format === "env") console.info(`WALLABY_CLIENT_ID=${created.clientId}\nWALLABY_CLIENT_SECRET=${created.clientSecret}`);
  else if (format === "text") console.info(`Client ID: ${created.clientId}\nClient secret: ${created.clientSecret}`);
  else throw new Error("format must be text, env, or json");
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally { await db.$disconnect(); }
