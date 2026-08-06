export function GET() {
  return Response.json({ appname: "wallabag", version: "0.1.0", allowed_registration: false });
}
