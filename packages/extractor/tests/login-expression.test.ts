import { describe, expect, it } from "vitest";

import { evaluateLoginExpression } from "../src/login-expression";

const noRequest = { loginUri: "https://site.example/login", requestHtml: async () => "" };

describe("evaluateLoginExpression", () => {
  it("returns a plain quoted string", async () => {
    expect(await evaluateLoginExpression("'hello world'", noRequest)).toBe("hello world");
    expect(await evaluateLoginExpression('"double"', noRequest)).toBe("double");
  });

  it("resolves config.getLoginUri() to the configured login URI", async () => {
    expect(await evaluateLoginExpression("config.getLoginUri()", noRequest)).toBe("https://site.example/login");
  });

  it("passes the resolved argument to request_html", async () => {
    const seen: string[] = [];
    const value = await evaluateLoginExpression("request_html(config.getLoginUri())", {
      loginUri: "https://site.example/login",
      requestHtml: async (url) => {
        seen.push(url);
        return "<html></html>";
      },
    });
    expect(seen).toEqual(["https://site.example/login"]);
    expect(value).toBe("<html></html>");
  });

  it("extracts an input value via xpath()", async () => {
    const result = await evaluateLoginExpression(
      "xpath('//input[@name=\"csrf\"]/@value', request_html('https://x/'))",
      { loginUri: "", requestHtml: async () => '<form><input name="csrf" value="tok-123"></form>' },
    );
    expect(result).toBe("tok-123");
  });

  it("extracts a capture group via preg_match()", async () => {
    const result = await evaluateLoginExpression(
      "preg_match('/token\":\"([a-z0-9]+)\"/i', request_html('https://x/'))",
      { loginUri: "", requestHtml: async () => '<script>{"token":"abc123"}</script>' },
    );
    expect(result).toBe("abc123");
  });

  it("returns empty string when xpath matches nothing", async () => {
    const result = await evaluateLoginExpression(
      "xpath('//input[@name=\"missing\"]/@value', request_html('https://x/'))",
      { loginUri: "", requestHtml: async () => "<form></form>" },
    );
    expect(result).toBe("");
  });

  it("rejects a catastrophic (unsafe) regex without hanging", async () => {
    const result = await evaluateLoginExpression(
      "preg_match('/(a+)+$/', request_html('https://x/'))",
      { loginUri: "", requestHtml: async () => "aaaaaaaaaaaaaaaaaaaaaaaa!" },
    );
    expect(result).toBe("");
  });

  it("rejects an unknown function name", async () => {
    await expect(evaluateLoginExpression("exec('rm -rf /')", noRequest)).rejects.toThrow(/Unsupported login expression function/);
  });

  it("does not evaluate bare identifiers as code", async () => {
    // `process` is not a defined function in the sandbox grammar; it must be treated as an unknown call, not JS.
    await expect(evaluateLoginExpression("process", noRequest)).rejects.toThrow();
  });

  it("rejects malformed expressions", async () => {
    await expect(evaluateLoginExpression("xpath('a'", noRequest)).rejects.toThrow();
    await expect(evaluateLoginExpression("'unterminated", noRequest)).rejects.toThrow();
    await expect(evaluateLoginExpression("config.getLoginUri('unexpected-arg')", noRequest)).rejects.toThrow(/does not accept arguments/);
  });
});
