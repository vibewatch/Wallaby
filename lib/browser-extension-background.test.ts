import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Message, Reply } from "../extensions/src/messages";

const root = "chrome-extension://wallaby-test/";
const configuration = { baseUrl: "https://reader.example.test", token: "test-only-token" };
const article = { id: "opaque-id", title: "Saved article", tags: [{ label: "Ideas" }], is_archived: 0, is_starred: 1, is_not_parsed: 0 };
type MessageHandler = (message: Message, sender: chrome.runtime.MessageSender, respond: (reply: Reply) => void) => boolean;
let listener: MessageHandler;
let contextClick: (info: chrome.contextMenus.OnClickData, tab?: chrome.tabs.Tab) => void;
let installed: () => void;
let store: Record<string, unknown>;
let granted: boolean;

const mock = {
  runtime: {
    id: "wallaby-test",
    getURL: (file: string) => `${root}${file}`,
    getPlatformInfo: vi.fn().mockResolvedValue({}),
    onMessage: { addListener: vi.fn((handler: MessageHandler) => { listener = handler; }) },
    onInstalled: { addListener: vi.fn((handler: () => void) => { installed = handler; }) },
    onStartup: { addListener: vi.fn() },
  },
  storage: { local: {
    get: vi.fn(async (key: string) => ({ [key]: store[key] })),
    set: vi.fn(async (values: Record<string, unknown>) => { Object.assign(store, values); }),
    remove: vi.fn(async (keys: string | string[]) => { for (const key of [keys].flat()) delete store[key]; }),
    setAccessLevel: vi.fn().mockResolvedValue(undefined),
  } },
  permissions: {
    contains: vi.fn(async () => granted),
    remove: vi.fn(async () => { granted = false; return true; }),
  },
  tabs: { create: vi.fn().mockResolvedValue({}) },
  action: {
    setBadgeText: vi.fn().mockResolvedValue(undefined),
    setBadgeBackgroundColor: vi.fn().mockResolvedValue(undefined),
    setTitle: vi.fn().mockResolvedValue(undefined),
  },
  contextMenus: {
    removeAll: vi.fn().mockResolvedValue(undefined),
    create: vi.fn(),
    onClicked: { addListener: vi.fn((handler: typeof contextClick) => { contextClick = handler; }) },
  },
  scripting: { executeScript: vi.fn() },
};

function dispatch(message: Message, sender: chrome.runtime.MessageSender = { id: mock.runtime.id, url: `${root}popup.html` }): Promise<Reply> {
  return new Promise((resolve) => {
    const accepted = listener(message, sender, resolve);
    if (!accepted) resolve({ ok: false, error: "Untrusted message rejected" });
  });
}

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  store = {};
  granted = true;
  mock.permissions.remove.mockImplementation(async () => { granted = false; return true; });
  vi.stubGlobal("chrome", mock);
  vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockImplementation(async () => Response.json(article)));
  await import("../extensions/src/background");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("extension background trust and connection lifecycle", () => {
  it("accepts extension options opened in a browser tab", async () => {
    expect(await dispatch({ type: "connection" }, { id: mock.runtime.id, url: `${root}options.html`, tab: { id: 1, index: 0, pinned: false, highlighted: true, windowId: 1, active: true, incognito: false, selected: true, discarded: false, autoDiscardable: true, groupId: -1, frozen: false, lastAccessed: Date.now() } })).toEqual({ ok: true, result: {} });
    expect(mock.storage.local.setAccessLevel).toHaveBeenCalledWith({ accessLevel: "TRUSTED_CONTEXTS" });
  });

  it.each([
    { id: "another-extension", url: `${root}popup.html` },
    { id: mock.runtime.id, url: "https://untrusted.example.test" },
    { id: mock.runtime.id, url: `${root}privacy.html` },
    { id: mock.runtime.id, url: `${root}popup.html.attacker` },
  ])("rejects messages outside the popup and options pages", async (sender) => {
    expect(await dispatch({ type: "disconnect" }, sender)).toMatchObject({ ok: false });
    expect(mock.storage.local.remove).not.toHaveBeenCalled();
  });

  it("verifies before storing credentials and never returns tokens", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(Response.json({ _embedded: { items: [] } }));
    expect(await dispatch({ type: "connect", ...configuration })).toEqual({ ok: true, result: { baseUrl: configuration.baseUrl } });
    expect(store.connection).toEqual(configuration);
    expect(await dispatch({ type: "connection" })).toEqual({ ok: true, result: { baseUrl: configuration.baseUrl } });
  });

  it("keeps the old connection after rejected credentials", async () => {
    store.connection = configuration;
    vi.mocked(fetch).mockResolvedValueOnce(new Response(null, { status: 401 }));
    expect(await dispatch({ type: "connect", ...configuration, token: "invalid" })).toMatchObject({ ok: false });
    expect(store.connection).toEqual(configuration);
    expect(mock.permissions.remove).not.toHaveBeenCalled();
  });

  it("removes newly granted host access when the first connection fails", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response(null, { status: 401 }));
    expect(await dispatch({ type: "connect", ...configuration })).toMatchObject({ ok: false });
    expect(store).toEqual({});
    expect(granted).toBe(false);
  });

  it("does not send credentials if site access is absent", async () => {
    granted = false;
    expect(await dispatch({ type: "connect", ...configuration })).toMatchObject({ ok: false });
    store.connection = configuration;
    expect(await dispatch({ type: "lookup", url: "https://news.example.test/story" })).toMatchObject({ ok: false });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("removes credentials and host access on disconnect", async () => {
    store.connection = configuration;
    store.lastContextSave = { at: Date.now(), message: "Saved" };
    expect(await dispatch({ type: "disconnect" })).toEqual({ ok: true, result: {} });
    expect(store).toEqual({});
    expect(mock.permissions.remove).toHaveBeenCalledWith({ origins: ["https://reader.example.test/*"] });
    expect(granted).toBe(false);
  });

  it("reports failed permission removal without leaving a token behind", async () => {
    store.connection = configuration;
    mock.permissions.remove.mockRejectedValueOnce(new Error("Browser denied removal"));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await dispatch({ type: "disconnect" })).toMatchObject({ ok: true, result: { warning: expect.stringContaining("could not be removed") } });
    expect(store).toEqual({});
  });

  it("reports tag-suggestion failures while preserving a successful lookup", async () => {
    store.connection = configuration;
    vi.mocked(fetch).mockResolvedValueOnce(Response.json({ exists: article.id })).mockResolvedValueOnce(Response.json(article)).mockResolvedValueOnce(new Response(null, { status: 500 }));
    expect(await dispatch({ type: "lookup", url: "https://news.example.test/story" })).toMatchObject({
      ok: true, result: { entry: { id: article.id }, warning: expect.stringContaining("suggestions"), tags: [] },
    });
  });
});

describe("extension capture and context-menu saving", () => {
  it("captures only after an explicit save and validates navigation", async () => {
    store.connection = configuration;
    mock.scripting.executeScript.mockResolvedValueOnce([]).mockResolvedValueOnce([{ result: { url: "https://other.example.test/story", content: "<p>Wrong article</p>" } }]);
    const result = await dispatch({ type: "save", url: "https://news.example.test/story", changes: { title: "Title", tags: [], archive: false, starred: false }, captureTabId: 42 });
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("page changed") });
    expect(mock.scripting.executeScript).toHaveBeenNthCalledWith(1, { target: { tabId: 42 }, files: ["capture.js"] });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("installs page and link context menus", async () => {
    installed();
    await vi.waitFor(() => expect(mock.contextMenus.create).toHaveBeenCalledTimes(2));
    expect(mock.contextMenus.create).toHaveBeenCalledWith(expect.objectContaining({ id: "wallaby-save-link", contexts: ["link"] }));
  });

  it("does not overwrite existing metadata from a context-menu save", async () => {
    store.connection = configuration;
    vi.mocked(fetch).mockResolvedValueOnce(Response.json({ exists: article.id })).mockResolvedValueOnce(Response.json(article));
    contextClick({ menuItemId: "wallaby-save-link", linkUrl: "https://news.example.test/story", editable: false });
    await vi.waitFor(() => expect(mock.action.setBadgeText).toHaveBeenCalled());
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(vi.mocked(fetch).mock.calls.every(([, init]) => init?.method === "GET")).toBe(true);
    expect(store.lastContextSave).toMatchObject({ message: "Already saved: Saved article" });
  });

  it("persists and displays context-menu authorization errors", async () => {
    store.connection = configuration;
    vi.mocked(fetch).mockResolvedValueOnce(new Response(null, { status: 401 }));
    contextClick({ menuItemId: "wallaby-save-page", pageUrl: "https://news.example.test/story", editable: false });
    await vi.waitFor(() => expect(mock.action.setBadgeText).toHaveBeenCalledWith({ text: "!" }));
    expect(store.lastContextSave).toMatchObject({ message: expect.stringContaining("rejected or revoked") });
  });
});
