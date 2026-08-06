export function apiError(status: number, error: string, description: string, details?: unknown): Response {
  return Response.json({
    error,
    error_description: description,
    message: description,
    "@context": "/api/contexts/Error",
    "@type": "hydra:Error",
    "hydra:title": errorTitle(status),
    "hydra:description": description,
    ...(details === undefined ? {} : { details }),
  }, { status });
}

export async function apiRequestObject(request: Request): Promise<Record<string, unknown> | null> {
  const contentType = request.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
  if (contentType === "application/json" || contentType?.endsWith("+json")) {
    const value = await request.json().catch(() => null) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  }
  const form = await request.formData().catch(() => null);
  if (!form) return null;
  const output: Record<string, unknown> = {};
  for (const [key, value] of form) {
    if (typeof value !== "string") continue;
    const current = output[key];
    output[key] = current === undefined ? value : Array.isArray(current) ? [...current, value] : [current, value];
  }
  return output;
}

export async function xmlApiResponse(response: Response, root = "response"): Promise<Response> {
  if (response.status === 204 || response.status === 304) return response;
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("json")) return response;
  const value = await response.json().catch(() => null) as unknown;
  const headers = new Headers(response.headers);
  headers.set("content-type", "application/xml; charset=utf-8");
  return new Response(`<?xml version="1.0" encoding="UTF-8"?>\n${xmlNode(safeXmlName(root), value)}`, { status: response.status, headers });
}

export function stripApiFormat(value: string): { id: string; format: "json" | "xml" } {
  if (value.endsWith(".xml")) return { id: value.slice(0, -4), format: "xml" };
  if (value.endsWith(".json")) return { id: value.slice(0, -5), format: "json" };
  return { id: value, format: "json" };
}

function xmlNode(name: string, value: unknown): string {
  if (Array.isArray(value)) return `<${name}>${value.map((item) => xmlNode("item", item)).join("")}</${name}>`;
  if (value && typeof value === "object") {
    return `<${name}>${Object.entries(value as Record<string, unknown>).map(([key, item]) => xmlNode(safeXmlName(key), item)).join("")}</${name}>`;
  }
  if (value === null || value === undefined) return `<${name} nil="true"/>`;
  return `<${name}>${escapeXml(String(value))}</${name}>`;
}

function safeXmlName(value: string): string {
  const cleaned = value.replace(/^@/, "").replace(/[^A-Za-z0-9_.-]+/g, "_");
  return /^[A-Za-z_]/.test(cleaned) ? cleaned : `field_${cleaned}`;
}

function escapeXml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[character]!);
}

function errorTitle(status: number): string {
  if (status === 400) return "Invalid request";
  if (status === 401) return "Authentication required";
  if (status === 403) return "Access denied";
  if (status === 404) return "Resource not found";
  if (status === 409) return "Conflict";
  return status >= 500 ? "Server error" : "Request failed";
}
