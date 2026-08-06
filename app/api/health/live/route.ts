export const dynamic = "force-dynamic";

export function GET() {
  return Response.json(
    { status: "ok", service: "wallaby", version: "0.1.0" },
    { headers: { "cache-control": "no-store" } },
  );
}
