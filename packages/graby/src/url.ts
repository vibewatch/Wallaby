import { lookup } from "node:dns/promises";

import ipaddr from "ipaddr.js";

const blockedHostnames = new Set(["localhost", "localhost.localdomain", "metadata.google.internal"]);
const blockedRanges = new Set([
  "unspecified",
  "broadcast",
  "multicast",
  "linkLocal",
  "loopback",
  "private",
  "reserved",
  "carrierGradeNat",
  "uniqueLocal",
  "ipv4Mapped",
  "rfc6145",
  "rfc6052",
  "6to4",
  "teredo",
]);

export function normalizeUrl(input: string | URL): URL {
  if (input instanceof URL) return new URL(input);
  let value = input.trim();
  if (!/^(https?|feed):\/\//i.test(value)) value = `https://${value}`;
  const url = new URL(value);
  if (url.protocol === "feed:") url.protocol = "https:";
  if (!['http:', 'https:'].includes(url.protocol)) throw new TypeError(`Unsupported URL scheme: ${url.protocol}`);
  if (url.username || url.password) throw new TypeError("URLs containing credentials are not allowed");
  return url;
}

export async function assertPublicUrl(url: URL): Promise<void> {
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (blockedHostnames.has(host) || host.endsWith(".localhost") || host.endsWith(".local")) {
    throw new TypeError(`Private hostname is not allowed: ${url.hostname}`);
  }

  const addresses = ipaddr.isValid(host)
    ? [host]
    : (await lookup(host, { all: true, verbatim: true })).map(({ address }) => address);
  if (!addresses.length) throw new TypeError(`Hostname did not resolve: ${url.hostname}`);

  for (const address of addresses) {
    const parsed = ipaddr.parse(address);
    if (blockedRanges.has(parsed.range())) {
      throw new TypeError(`URL resolves to a non-public address: ${address}`);
    }
  }
}

export function absoluteUrl(value: string | null | undefined, base: URL): string | null {
  if (!value || /^data:/i.test(value)) return null;
  try {
    return new URL(value, base).toString();
  } catch {
    return null;
  }
}
