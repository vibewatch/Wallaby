import type { Instrumentation } from "next";

export function register() {
  if (process.env.NEXT_RUNTIME === "nodejs" && process.env.NODE_ENV === "production") {
    console.info(JSON.stringify({
      level: "info",
      event: "server.started",
      service: "wallaby",
      version: "0.1.0",
      pid: process.pid,
      timestamp: new Date().toISOString(),
    }));
  }
}

export const onRequestError: Instrumentation.onRequestError = async (error, _request, context) => {
  const digest = typeof error === "object" && error !== null && "digest" in error ? String(error.digest) : undefined;
  console.error(JSON.stringify({
    level: "error",
    event: "request.failed",
    service: "wallaby",
    errorType: error instanceof Error ? error.name : typeof error,
    digest,
    route: context.routePath,
    routeType: context.routeType,
    router: context.routerKind,
    timestamp: new Date().toISOString(),
  }));
};
