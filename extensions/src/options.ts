import { hostPermission, instanceUrl } from "./api";
import { api } from "./browser";
import { send } from "./messages";
import { element, messageOf, showStatus } from "./ui";

const form = element("form", HTMLFormElement);
const address = element("#instance", HTMLInputElement);
const token = element("#token", HTMLInputElement);
const connect = element("#connect", HTMLButtonElement);
const disconnect = element("#disconnect", HTMLButtonElement);
const account = element("#account", HTMLElement);
const tokenHelp = element("#token-help", HTMLAnchorElement);

function connectionState(baseUrl?: string) {
  account.textContent = baseUrl ? `Connected to ${baseUrl}` : "Your library, wherever you browse.";
  disconnect.hidden = !baseUrl;
  if (baseUrl) {
    address.value = baseUrl;
    tokenHelp.href = `${baseUrl}/entries/settings`;
    tokenHelp.hidden = false;
  } else {
    tokenHelp.hidden = true;
    tokenHelp.removeAttribute("href");
  }
}

address.addEventListener("input", () => {
  try {
    tokenHelp.href = `${instanceUrl(address.value)}/entries/settings`;
    tokenHelp.hidden = false;
  } catch {
    tokenHelp.hidden = true;
    tokenHelp.removeAttribute("href");
  }
});

form.addEventListener("submit", (event) => {
  event.preventDefault();
  void (async () => {
    connect.disabled = true;
    disconnect.disabled = true;
    try {
      const baseUrl = instanceUrl(address.value);
      const granted = await api.permissions.request({ origins: [hostPermission(baseUrl)] });
      if (!granted) throw new Error("Site access was not granted. Allow your Wallaby instance to connect.");
      showStatus("Checking your instance and API token…");
      const result = await send({ type: "connect", baseUrl, token: token.value });
      token.value = "";
      connectionState(result.baseUrl);
      showStatus(result.warning ? `Connected. ${result.warning}` : "Connected. Open an article, then click the Wallaby toolbar icon.");
    } catch (error) { showStatus(messageOf(error), true); }
    finally { connect.disabled = false; disconnect.disabled = false; }
  })();
});

disconnect.addEventListener("click", () => {
  disconnect.disabled = true;
  connect.disabled = true;
  void send({ type: "disconnect" }).then((result) => {
    token.value = "";
    connectionState();
    showStatus(result.warning ? `Disconnected. The saved token was removed. ${result.warning}` :
      "Disconnected. The saved token and instance permission have been removed. You can also revoke the token in Wallaby Settings.");
  }).catch((error: unknown) => showStatus(messageOf(error), true))
    .finally(() => { disconnect.disabled = false; connect.disabled = false; });
});

void send({ type: "connection" }).then(({ baseUrl }) => connectionState(baseUrl))
  .catch((error: unknown) => showStatus(messageOf(error), true));
