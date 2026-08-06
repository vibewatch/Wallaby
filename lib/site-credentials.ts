import type { SiteCredential as GrabySiteCredential } from "@wallaby/graby";

import { db } from "@/lib/db";
import { decryptSecret, encryptSecret } from "@/lib/secret-box";

export function normalizeCredentialHost(input: string): string {
  const value = input.trim().toLowerCase();
  let host: string;
  try {
    host = new URL(value.includes("://") ? value : `https://${value}`).hostname;
  } catch {
    throw new Error("Enter a valid site hostname");
  }
  host = host.replace(/^www\./, "").replace(/\.$/, "");
  if (!host || !host.includes(".")) throw new Error("Enter a public site hostname");
  return host;
}

export async function findSiteCredential(userId: string, rawHost: string): Promise<GrabySiteCredential | undefined> {
  const host = normalizeCredentialHost(rawHost);
  const labels = host.split(".");
  const wildcard = labels.length > 1 ? `.${labels.slice(1).join(".")}` : null;
  const credentials = await db.siteCredential.findMany({
    where: { userId, host: { in: wildcard ? [host, wildcard] : [host] } },
  });
  const credential = credentials.find((item) => item.host === host) ?? credentials.find((item) => item.host === wildcard);
  if (!credential) return undefined;
  return {
    username: decryptSecret(credential.encryptedUsername),
    password: decryptSecret(credential.encryptedPassword),
  };
}

export async function upsertSiteCredential(userId: string, hostInput: string, username: string, password: string) {
  const host = normalizeCredentialHost(hostInput);
  return db.siteCredential.upsert({
    where: { userId_host: { userId, host } },
    create: {
      userId,
      host,
      encryptedUsername: encryptSecret(username),
      encryptedPassword: encryptSecret(password),
    },
    update: {
      encryptedUsername: encryptSecret(username),
      encryptedPassword: encryptSecret(password),
    },
  });
}
