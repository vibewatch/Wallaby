import { SMTPClient } from "emailjs";

/**
 * Outgoing instance email: two-factor codes and password-reset links. The
 * settings keep their original `TWO_FACTOR_` names so existing deployments
 * need no changes.
 */

export function isInstanceEmailConfigured(): boolean {
  return Boolean(process.env.TWO_FACTOR_SMTP_HOST?.trim() && process.env.TWO_FACTOR_EMAIL_FROM?.trim());
}

export async function sendInstanceEmail({ to, subject, text }: { to: string; subject: string; text: string }): Promise<void> {
  const host = process.env.TWO_FACTOR_SMTP_HOST?.trim();
  const from = process.env.TWO_FACTOR_EMAIL_FROM?.trim();
  if (!host || !from) throw new Error("Instance email delivery is not configured");
  const security = process.env.TWO_FACTOR_SMTP_SECURITY?.trim().toLowerCase() || "starttls";
  if (!["tls", "starttls", "none"].includes(security)) throw new Error("TWO_FACTOR_SMTP_SECURITY must be tls, starttls, or none");
  const port = Number.parseInt(process.env.TWO_FACTOR_SMTP_PORT || (security === "tls" ? "465" : "587"), 10);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("TWO_FACTOR_SMTP_PORT is invalid");
  const client = new SMTPClient({
    host,
    port,
    user: process.env.TWO_FACTOR_SMTP_USER || "",
    password: process.env.TWO_FACTOR_SMTP_PASSWORD || "",
    ssl: security === "tls",
    tls: security === "starttls",
    timeout: 10_000,
  });
  try {
    await client.sendAsync({ from, to, subject, text });
  } finally {
    client.smtp.close(true);
  }
}
