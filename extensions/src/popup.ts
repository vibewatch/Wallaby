import { articleUrl, tagLabels, type SavedEntry } from "./api";
import { api } from "./browser";
import { send } from "./messages";
import { element, messageOf, showStatus } from "./ui";

const form = element("form", HTMLFormElement);
const title = element("#title", HTMLInputElement);
const tags = element("#tags", HTMLInputElement);
const starred = element("#starred", HTMLInputElement);
const archive = element("#archive", HTMLInputElement);
const capture = element("#capture", HTMLInputElement);
const captureRow = element("#capture-row", HTMLElement);
const submit = element("#save", HTMLButtonElement);
const reader = element("#reader", HTMLButtonElement);
const remove = element("#remove", HTMLButtonElement);
const confirmRemove = element("#confirm-remove", HTMLButtonElement);
const removal = element("#removal", HTMLElement);
const retry = element("#retry", HTMLButtonElement);
const host = element("#host", HTMLElement);
const heading = element("#heading", HTMLElement);
let entry: SavedEntry | null = null;
let tab: chrome.tabs.Tab | undefined;
let url = "";
let ready = false;

function busy(value: boolean) {
  for (const input of form.querySelectorAll("input, button")) {
    if (input instanceof HTMLInputElement || input instanceof HTMLButtonElement) input.disabled = value;
  }
  remove.disabled = value;
  confirmRemove.disabled = value;
  reader.disabled = value;
  retry.disabled = value;
  form.setAttribute("aria-busy", String(value));
}

function display(value: SavedEntry | null) {
  entry = value;
  heading.textContent = value ? "Back on your shelf." : "A good read, kept.";
  title.value = value?.title ?? tab?.title ?? "";
  tags.value = value?.tags.join(", ") ?? "";
  starred.checked = value?.starred ?? false;
  archive.checked = value?.archived ?? false;
  submit.textContent = value ? "Update article" : "Save article";
  reader.hidden = !value;
  remove.hidden = !value;
  captureRow.hidden = Boolean(value);
  capture.checked = false;
  removal.hidden = true;
}

async function initialize() {
  ready = false;
  retry.hidden = true;
  form.hidden = true;
  busy(true);
  showStatus("Finding your place…");
  try {
    const connection = await send({ type: "connection" });
    if (!connection.baseUrl) {
      showStatus("Connect your Wallaby instance to start collecting.");
      element("#setup", HTMLButtonElement).hidden = false;
      return;
    }
    element("#setup", HTMLButtonElement).hidden = true;
    [tab] = await api.tabs.query({ active: true, currentWindow: true });
    url = articleUrl(tab?.url ?? "");
    host.textContent = new URL(url).hostname;
    const result = await send({ type: "lookup", url });
    const suggestions = element("#tag-suggestions", HTMLDataListElement);
    suggestions.replaceChildren(...(result.tags ?? []).map((label) => {
      const option = document.createElement("option");
      option.value = label;
      return option;
    }));
    display(result.entry ?? null);
    form.hidden = false;
    ready = true;
    showStatus(result.warning ?? (entry?.incomplete ? "Saved, but extraction was incomplete. Open the reader to retry." : entry ? "Already in your library. Make it easier to find again." : "Save a little attention for later."));
    if (connection.notice) element("#recent", HTMLElement).textContent = `Last context-menu save: ${connection.notice}`;
  } catch (error) {
    showStatus(messageOf(error), true);
    retry.hidden = false;
  } finally { busy(false); }
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  if (!ready) return;
  const changes = { title: title.value, tags: tagLabels(tags.value), archive: archive.checked, starred: starred.checked };
  busy(true);
  showStatus(entry ? "Updating your article…" : "Saving your article…");
  void send(entry
    ? { type: "update", id: entry.id, changes }
    : { type: "save", url, changes, ...(capture.checked && tab?.id !== undefined ? { captureTabId: tab.id } : {}) })
    .then((result) => {
      if (!result.entry) throw new Error("Your instance did not return the saved article.");
      display(result.entry);
      showStatus(result.entry.incomplete
        ? "Saved, but the full text could not be extracted. Open the reader to retry."
        : "On your shelf. Ready when you are.");
    })
    .catch((error: unknown) => showStatus(messageOf(error), true))
    .finally(() => busy(false));
});

remove.addEventListener("click", () => {
  removal.hidden = false;
  confirmRemove.focus();
});
element("#keep", HTMLButtonElement).addEventListener("click", () => { removal.hidden = true; remove.focus(); });
confirmRemove.addEventListener("click", () => {
  if (!entry || !ready) return;
  busy(true);
  void send({ type: "delete", id: entry.id }).then(() => {
    display(null);
    showStatus("Removed from your library.");
  }).catch((error: unknown) => showStatus(messageOf(error), true)).finally(() => busy(false));
});

reader.addEventListener("click", () => {
  if (entry) void send({ type: "open", id: entry.id }).catch((error: unknown) => showStatus(messageOf(error), true));
});
element("#library", HTMLButtonElement).addEventListener("click", () => {
  void send({ type: "open" }).catch((error: unknown) => showStatus(messageOf(error), true));
});
for (const button of [element("#settings", HTMLButtonElement), element("#setup", HTMLButtonElement)]) {
  button.addEventListener("click", () => { void api.runtime.openOptionsPage().catch((error: unknown) => showStatus(messageOf(error), true)); });
}
retry.addEventListener("click", () => { void initialize(); });
void initialize();
