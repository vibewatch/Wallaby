import { createServer } from "node:net";

export type CapturedMail = { from: string; to: string[]; body: string };

/**
 * Just enough SMTP to accept what the app sends during a test, with no TLS
 * and no authentication, so email flows can be followed end to end.
 */
export async function startMailSink(port: number) {
  const messages: CapturedMail[] = [];
  const server = createServer((socket) => {
    socket.setEncoding("utf8");
    let buffer = "";
    let receiving = false;
    let current: CapturedMail = { from: "", to: [], body: "" };
    const reply = (line: string) => socket.write(`${line}\r\n`);
    reply("220 wallaby-e2e ESMTP");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      for (let index = buffer.indexOf("\r\n"); index !== -1; index = buffer.indexOf("\r\n")) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        if (receiving) {
          if (line === ".") {
            receiving = false;
            messages.push({ ...current, body: decodeQuotedPrintable(current.body) });
            current = { from: "", to: [], body: "" };
            reply("250 OK");
          } else current.body += `${line.startsWith("..") ? line.slice(1) : line}\r\n`;
          continue;
        }
        const verb = line.split(" ", 1)[0].toUpperCase();
        if (verb === "EHLO" || verb === "HELO") reply("250 wallaby-e2e");
        else if (verb === "MAIL") { current.from = address(line); reply("250 OK"); }
        else if (verb === "RCPT") { current.to.push(address(line)); reply("250 OK"); }
        else if (verb === "DATA") { receiving = true; reply("354 End data with <CR><LF>.<CR><LF>"); }
        else if (verb === "RSET") { current = { from: "", to: [], body: "" }; reply("250 OK"); }
        else if (verb === "NOOP") reply("250 OK");
        else if (verb === "QUIT") { reply("221 Bye"); socket.end(); }
        else reply("502 Command not implemented");
      }
    });
    socket.on("error", () => undefined);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  return {
    messages,
    async waitFor(recipient: string, timeoutMs = 10_000): Promise<CapturedMail> {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const found = messages.find((message) => message.to.includes(recipient));
        if (found) return found;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw new Error(`No email arrived for ${recipient}`);
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function address(line: string): string {
  return /<([^>]*)>/.exec(line)?.[1].toLowerCase() ?? "";
}

function decodeQuotedPrintable(text: string): string {
  return text.replace(/=\r\n/g, "").replace(/=([0-9A-F]{2})/g, (_match, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
}
