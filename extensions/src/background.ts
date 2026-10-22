import { articleUrl, connectionInput, hostPermission, readerUrl, WallabyClient, type Connection } from "./api";
import { api } from "./browser";
import type { Message, Reply, Result } from "./messages";

declare const WallabyCapture: { capture: () => { url: string; content: string } };

const CONFIG_KEY = "connection";
const STATUS_KEY = "lastContextSave";

async function revokeHost(baseUrl: string): Promise<boolean> {
  const permission = { origins: [hostPermission(baseUrl)] };
  try {
    await api.permissions.remove(permission);
    return !await api.permissions.contains(permission);
  } catch {
    console.warn("Wallaby could not remove an instance's site permission. Remove it in browser extension settings.");
    return false;
  }
}

async function connection(): Promise<Connection> {
  const stored = (await api.storage.local.get(CONFIG_KEY))[CONFIG_KEY];
  if (!stored) throw new Error("Connect your Wallaby instance in extension settings first.");
  const config = connectionInput(stored);
  if (!await api.permissions.contains({ origins: [hostPermission(config.baseUrl)] })) {
    throw new Error("Site access was removed. Reconnect your instance in extension settings.");
  }
  return config;
}

async function handle(message: Message): Promise<Result> {
  if (message.type === "connection") {
    const stored = (await api.storage.local.get(CONFIG_KEY))[CONFIG_KEY];
    const status = (await api.storage.local.get(STATUS_KEY))[STATUS_KEY];
    return {
      ...(stored ? { baseUrl: instanceAddress(stored) } : {}),
      ...(status && typeof status === "object" && "at" in status && typeof status.at === "number" &&
        "message" in status && typeof status.message === "string" && Date.now() - status.at < 300_000 ? { notice: status.message } : {}),
    };
  }
  if (message.type === "disconnect") {
    const stored = (await api.storage.local.get(CONFIG_KEY))[CONFIG_KEY];
    await api.storage.local.remove([CONFIG_KEY, STATUS_KEY]);
    const revoked = !stored || await revokeHost(instanceAddress(stored));
    await api.action.setBadgeText({ text: "" });
    return revoked ? {} : { warning: "Site access could not be removed. Remove it in your browser's extension settings." };
  }
  if (message.type === "connect") {
    const config = connectionInput(message);
    if (!await api.permissions.contains({ origins: [hostPermission(config.baseUrl)] })) throw new Error("Allow access to your instance before connecting.");
    const previous = (await api.storage.local.get(CONFIG_KEY))[CONFIG_KEY];
    try { await new WallabyClient(config).verify(); }
    catch (error) {
      const revoked = previous && hostPermission(instanceAddress(previous)) === hostPermission(config.baseUrl) ||
        await revokeHost(config.baseUrl);
      throw new Error(`${errorMessage(error)}${revoked ? "" : " Site access could not be removed. Remove it in browser extension settings."}`);
    }
    await api.storage.local.set({ [CONFIG_KEY]: config });
    await api.storage.local.remove(STATUS_KEY);
    const revoked = !previous || hostPermission(instanceAddress(previous)) === hostPermission(config.baseUrl) ||
      await revokeHost(instanceAddress(previous));
    return { baseUrl: config.baseUrl, ...(!revoked ? { warning: "The old instance still has site access. Remove it in your browser's extension settings." } : {}) };
  }
  const config = await connection();
  const client = new WallabyClient(config);
  if (message.type === "lookup") {
    const entry = await client.find(message.url);
    try { return { entry, tags: await client.tags() }; }
    catch { return { entry, tags: [], warning: "Tag suggestions could not load. You can still enter tags manually." }; }
  }
  if (message.type === "save") {
    let content: string | undefined;
    if (message.captureTabId !== undefined) {
      await api.scripting.executeScript({ target: { tabId: message.captureTabId }, files: ["capture.js"] });
      const [captured] = await api.scripting.executeScript({
        target: { tabId: message.captureTabId },
        func: () => WallabyCapture.capture(),
      });
      if (!captured?.result || articleUrl(captured.result.url) !== articleUrl(message.url)) {
        throw new Error("The page changed while saving. Reopen the extension on the article.");
      }
      content = captured.result.content;
    }
    return { entry: await client.save(message.url, message.changes, content) };
  }
  if (message.type === "update") return { entry: await client.update(message.id, message.changes) };
  if (message.type === "delete") { await client.remove(message.id); return {}; }
  if (message.type === "open") {
    await api.tabs.create({ url: message.id ? readerUrl(config.baseUrl, message.id) : `${config.baseUrl}/entries` });
    return {};
  }
  throw new Error("Unknown extension action. Reload the extension and try again.");
}

function instanceAddress(value: unknown): string {
  if (!value || typeof value !== "object" || !("baseUrl" in value) || typeof value.baseUrl !== "string") {
    throw new Error("The stored connection is invalid. Reconnect in extension settings.");
  }
  return value.baseUrl;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "The extension could not complete this action. Please retry.";
}

async function keepWorkerAlive<T>(operation: () => Promise<T>): Promise<T> {
  // A publisher fetch can exceed a Chrome worker's idle period.
  const interval = setInterval(() => {
    void api.runtime.getPlatformInfo().catch(() => console.warn("Wallaby could not keep its worker active. Reopen the popup to check whether the save completed."));
  }, 20_000);
  try { return await operation(); }
  finally { clearInterval(interval); }
}

api.runtime.onMessage.addListener((message: Message, sender, respond: (reply: Reply) => void) => {
  if (sender.id !== api.runtime.id ||
    !["popup.html", "options.html"].some((page) => sender.url === api.runtime.getURL(page))) return false;
  void keepWorkerAlive(() => handle(message))
    .then((result) => respond({ ok: true, result }))
    .catch((error: unknown) => respond({ ok: false, error: errorMessage(error) }));
  return true;
});

async function createMenus() {
  await api.contextMenus.removeAll();
  api.contextMenus.create({ id: "wallaby-save-page", title: "Save page to Wallaby", contexts: ["page"], documentUrlPatterns: ["http://*/*", "https://*/*"] });
  api.contextMenus.create({ id: "wallaby-save-link", title: "Save link to Wallaby", contexts: ["link"], targetUrlPatterns: ["http://*/*", "https://*/*"] });
}

api.runtime.onInstalled.addListener(() => { void createMenus().catch(() => console.error("Wallaby could not install its context menus.")); });
api.runtime.onStartup.addListener(() => { void createMenus().catch(() => console.error("Wallaby could not restore its context menus.")); });
api.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== "wallaby-save-page" && info.menuItemId !== "wallaby-save-link") return;
  const url = info.menuItemId === "wallaby-save-link" ? info.linkUrl : info.pageUrl;
  if (!url) return;
  void keepWorkerAlive(async () => {
    let notice: string;
    let badge: string;
    try {
      const client = new WallabyClient(await connection());
      const existing = await client.find(url);
      const entry = existing ?? await client.save(url);
      notice = `${existing ? "Already saved" : "Saved"}: ${entry.title}${entry.incomplete ? ". Extraction was incomplete; open the reader to retry." : ""}`;
      badge = entry.incomplete ? "!" : "✓";
    } catch (error) {
      notice = errorMessage(error);
      badge = "!";
    }
    await api.storage.local.set({ [STATUS_KEY]: { at: Date.now(), message: notice } });
    await api.action.setBadgeBackgroundColor({ color: badge === "!" ? "#9f3d36" : "#b74e32" });
    await api.action.setBadgeText({ text: badge, ...(tab?.id === undefined ? {} : { tabId: tab.id }) });
    await api.action.setTitle({ title: `Wallaby — ${notice}`, ...(tab?.id === undefined ? {} : { tabId: tab.id }) });
  }).catch(() => console.error("Wallaby could not display the context-menu save result. Open the popup to check your library."));
});

if (api.storage.local.setAccessLevel) {
  void api.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" })
    .catch(() => console.error("Wallaby could not restrict local storage access."));
}
