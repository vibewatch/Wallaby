import type { EntryChanges, SavedEntry } from "./api";
import { api } from "./browser";

export type Message =
  | { type: "connection" }
  | { type: "connect"; baseUrl: string; token: string }
  | { type: "disconnect" }
  | { type: "lookup"; url: string }
  | { type: "save"; url: string; changes: EntryChanges; captureTabId?: number }
  | { type: "update"; id: string; changes: EntryChanges }
  | { type: "delete"; id: string }
  | { type: "open"; id?: string };

export type Result = { baseUrl?: string; entry?: SavedEntry | null; tags?: string[]; notice?: string; warning?: string };
export type Reply = { ok: true; result: Result } | { ok: false; error: string };

export async function send(message: Message): Promise<Result> {
  const reply: Reply | undefined = await api.runtime.sendMessage(message);
  if (!reply) throw new Error("The extension restarted. Close and reopen this page, then try again.");
  if (!reply.ok) throw new Error(reply.error);
  return reply.result;
}
