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

/**
 * React aborts a streaming render with this message when the browser stops
 * reading it, as when the reader navigates on before a page finishes. That is
 * not a server failure and must not trip alerts on `request.failed`.
 */
const CLIENT_DISCONNECTED = "The destination stream closed early.";

export const onRequestError: Instrumentation.onRequestError = async (error, _request, context) => {
  const digest = typeof error === "object" && error !== null && "digest" in error ? String(error.digest) : undefined;
  const disconnected = error instanceof Error && error.message === CLIENT_DISCONNECTED;
  (disconnected ? console.info : console.error)(JSON.stringify({
    level: disconnected ? "info" : "error",
    event: disconnected ? "request.aborted" : "request.failed",
    service: "wallaby",
    errorType: error instanceof Error ? error.name : typeof error,
    digest,
    route: context.routePath,
    routeType: context.routeType,
    router: context.routerKind,
    timestamp: new Date().toISOString(),
  }));
};
