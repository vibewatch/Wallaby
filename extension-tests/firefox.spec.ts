import { expect, firefox, test } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { once } from "node:events";
import { strToU8, unzipSync, zipSync } from "fflate";
import { z } from "zod";
import { e2eBaseUrl, e2eEnvironment } from "../e2e/environment";
import type { Message } from "../extensions/src/messages";

async function listen(server: Server): Promise<number> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("The Firefox fixture could not open a local port.");
  return address.port;
}

test("Firefox event page connects, captures content, updates, revokes, and disconnects", async ({}, testInfo) => {
  const prisma = new PrismaClient({ datasources: { db: { url: e2eEnvironment.DATABASE_URL } } });
  const contentServer = createServer((_, response) => {
    response.writeHead(200, { "Content-Type": "text/html" });
    response.end(`<!doctype html><html lang="en"><head><title>A Firefox reading habit</title></head><body><article><h1>A Firefox reading habit</h1>${"<p>A meaningful reading habit lets us keep the ideas worth returning to. This article can only be read inside this browser session and should be captured from the visible page.</p>".repeat(12)}</article></body></html>`);
  });
  const articlePort = await listen(contentServer);
  const articleAddress = `http://127.0.0.1:${articlePort}/article`;
  const portReservation = createServer();
  const driverPort = await listen(portReservation);
  await new Promise<void>((resolve, reject) => portReservation.close((error) => error ? reject(error) : resolve()));
  const driver = spawn(process.env.GECKODRIVER_PATH ?? "geckodriver", [
    "--host", "127.0.0.1", "--port", String(driverPort), "--log", "error", "--allow-system-access",
  ], { stdio: ["ignore", "pipe", "pipe"] });
  let startupError: Error | undefined;
  let driverOutput = "";
  driver.on("error", (error) => { startupError = error; });
  for (const stream of [driver.stdout, driver.stderr]) stream.on("data", (chunk: Buffer) => { driverOutput += chunk.toString(); });
  const endpoint = `http://127.0.0.1:${driverPort}`;
  let sessionId: string | undefined;

  async function request(method: string, route: string, body?: unknown): Promise<unknown> {
    const response = await fetch(`${endpoint}${route}`, {
      method, headers: { "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30_000),
    });
    const result = z.object({ value: z.unknown() }).parse(await response.json());
    if (!response.ok) throw new Error(`Firefox WebDriver failed: ${JSON.stringify(result.value)}`);
    return result.value;
  }
  const execute = (script: string, args: unknown[] = []) => request("POST", `/session/${sessionId}/execute/sync`, { script, args });
  const send = (message: Message) => request("POST", `/session/${sessionId}/execute/async`, {
    script: "const done=arguments[arguments.length-1]; browser.runtime.sendMessage(arguments[0]).then(done, e=>done({ok:false,error:String(e)}));",
    args: [message],
  });
  try {
    await expect.poll(async () => {
      if (startupError) throw new Error("Install geckodriver on PATH or set GECKODRIVER_PATH before running Firefox extension tests.", { cause: startupError });
      try { return (await fetch(`${endpoint}/status`)).ok; }
      catch { return false; }
    }, { timeout: 10_000 }).toBe(true);
    const token = randomUUID();
    const user = await prisma.user.findUniqueOrThrow({ where: { username: "test-reader" } });
    const tokenRecord = await prisma.apiToken.create({ data: {
      userId: user.id, name: "Firefox browser acceptance", tokenHash: createHash("sha256").update(token).digest("hex"),
    } });
    const files = unzipSync(await readFile(".tmp/extensions/wallaby-firefox.zip"));
    const manifest = JSON.parse(new TextDecoder().decode(files["manifest.json"]));
    // Only this disposable fixture grants local hosts in advance.
    manifest.host_permissions = ["http://127.0.0.1/*"];
    files["manifest.json"] = strToU8(JSON.stringify(manifest));
    const addon = testInfo.outputPath("wallaby-test-firefox.zip");
    await writeFile(addon, zipSync(files));
    const uuid = "1b1329f5-e731-48aa-b4c7-b9edc03a77a1";
    sessionId = z.object({ sessionId: z.string() }).parse(await request("POST", "/session", {
      capabilities: { alwaysMatch: {
        browserName: "firefox",
        "moz:firefoxOptions": {
          binary: firefox.executablePath(), args: ["-headless"],
          prefs: { "extensions.webextensions.uuids": JSON.stringify({ "wallaby@huangyingting.github.io": uuid }) },
        },
      } },
    })).sessionId;
    expect(await request("POST", `/session/${sessionId}/moz/addon/install`, { path: addon, temporary: true })).toBe("wallaby@huangyingting.github.io");
    await request("POST", `/session/${sessionId}/moz/context`, { context: "chrome" });
    await execute("window.gBrowser.selectedBrowser.loadURI(Services.io.newURI(arguments[0]), {triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal()});", [`moz-extension://${uuid}/options.html`]);
    await request("POST", `/session/${sessionId}/moz/context`, { context: "content" });
    await expect.poll(() => execute("return document.readyState;")).toBe("complete");
    await expect.poll(() => execute("return typeof browser;")).toBe("object");
    await execute("document.querySelector('#instance').value=arguments[0]; document.querySelector('#token').value=arguments[1];", [e2eBaseUrl, token]);
    const button = z.record(z.string(), z.string()).parse(await request("POST", `/session/${sessionId}/element`, { using: "css selector", value: "#connect" }));
    await request("POST", `/session/${sessionId}/element/${button["element-6066-11e4-a52e-4f735466cecf"]}/click`, {});
    await expect.poll(() => execute("return document.querySelector('#account').textContent;")).toBe(`Connected to ${e2eBaseUrl}`);
    expect(await send({ type: "connection" })).toEqual({ ok: true, result: { baseUrl: e2eBaseUrl } });
    const tab = z.object({ id: z.number() }).parse(await request("POST", `/session/${sessionId}/execute/async`, {
      script: "const done=arguments[arguments.length-1]; browser.tabs.create({url:arguments[0],active:false}).then(done);", args: [articleAddress],
    }));
    await expect.poll(() => request("POST", `/session/${sessionId}/execute/async`, {
      script: "const done=arguments[arguments.length-1]; browser.tabs.get(arguments[0]).then(tab=>done(tab.status));", args: [tab.id],
    })).toBe("complete");
    expect(await send({ type: "lookup", url: articleAddress })).toMatchObject({ ok: true, result: { entry: null } });
    expect(await send({
      type: "save", url: articleAddress, captureTabId: tab.id,
      changes: { title: "Firefox reading", tags: ["Browser"], archive: false, starred: true },
    })).toMatchObject({ ok: true, result: { entry: { title: "Firefox reading", tags: ["Browser"], incomplete: false } } });
    const saved = await prisma.entry.findFirstOrThrow({ where: { userId: user.id, givenUrl: articleAddress } });
    expect(saved.content).toContain("A meaningful reading habit");
    expect(await send({ type: "update", id: saved.id, changes: { title: "Edited in Firefox", tags: [], archive: true, starred: false } }))
      .toMatchObject({ ok: true, result: { entry: { title: "Edited in Firefox", tags: [], archived: true, starred: false } } });
    expect(await send({ type: "delete", id: saved.id })).toEqual({ ok: true, result: {} });
    expect(await prisma.entry.count({ where: { id: saved.id } })).toBe(0);
    await prisma.apiToken.delete({ where: { id: tokenRecord.id } });
    expect(await send({ type: "lookup", url: articleAddress })).toMatchObject({ ok: false, error: expect.stringContaining("rejected or revoked") });
    expect(await send({ type: "disconnect" })).toMatchObject({ ok: true });
    expect(await request("POST", `/session/${sessionId}/execute/async`, {
      script: "const done=arguments[arguments.length-1]; browser.storage.local.get().then(done);", args: [],
    })).toEqual({});
  } finally {
    try {
      if (sessionId) await request("DELETE", `/session/${sessionId}`);
    } finally {
      driver.kill();
      await new Promise<void>((resolve, reject) => contentServer.close((error) => error ? reject(error) : resolve()));
      await prisma.$disconnect();
      await testInfo.attach("firefox-driver.log", { body: driverOutput, contentType: "text/plain" });
    }
  }
});
