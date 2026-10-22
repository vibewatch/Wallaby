# Wallaby browser companion

Save pages and links to your own Wallaby instance from Chrome or Firefox. This is
a Wallaby-specific implementation referencing the MIT-licensed
[Wallabagger](https://github.com/wallabag/wallabagger) extension, not a build of
Wallabagger and not an extension for arbitrary wallabag servers. Reference source
and licenses are recorded in `THIRD-PARTY-NOTICES.txt`.

## Build and install

From the repository root, with the project's Node version and dependencies installed:

```sh
npm ci
npm run extension:build
```

| Browser | Unpacked directory | Package |
| --- | --- | --- |
| Chrome 116+ | `.tmp/extensions/chrome` | `.tmp/extensions/wallaby-chrome.zip` |
| Firefox 142+ | `.tmp/extensions/firefox` | `.tmp/extensions/wallaby-firefox.zip` |

**Chrome:** open `chrome://extensions`, enable **Developer mode**, choose **Load
unpacked**, and select the Chrome directory.

**Firefox development:** open `about:debugging#/runtime/this-firefox`, choose
**Load Temporary Add-on**, and select the Firefox directory's `manifest.json`.
Temporary add-ons are removed when Firefox restarts. Permanent installation in
normal Firefox requires Mozilla signing; submit the Firefox ZIP to AMO for
listed or unlisted signing. The ZIP is not a signed XPI. Chrome Web Store
publication also requires a publisher account and store review. Neither package
is published or signed by the build.

## Connect once

1. In your Wallaby instance, open **Settings → API access** and create a dedicated
   API token for this browser. Copy it when shown; it is displayed only once.
2. Open the extension's settings. Enter the instance's HTTPS root address
   (for example, `https://read.example.com`) and the token. Grant access to that
   instance when prompted and connect.
3. Pin the Wallaby toolbar icon. Open an article and click it, or press
   **Alt+Shift+W** (browser shortcut settings can remap it).

HTTP is accepted only for `localhost`, `127.0.0.1`, and `::1` development servers.
Use a valid HTTPS certificate in production. Requests reject redirects: enter
the final canonical instance address, not an address that redirects to it.

## What it does

- Checks whether the current article is already saved when you open the popup.
- Saves articles and edits their title, tags, favorite state, and read state.
- Offers existing tag suggestions. Separate multiple tags with commas.
- Opens the article in Wallaby's reader or removes it from the library.
- Saves a page or link from its context menu without overwriting an existing
  article's metadata. The toolbar badge and next popup show the last result.
- Optionally captures a readable article from the current page, using Mozilla
  Readability, when saving a new article. This is useful for content you are
  signed in to read; it does not send your cookies or bypass access controls.
  Only save content you have permission to retain.

The regular save path lets the server extract the article. If the publisher
cannot be fetched or parsed, Wallaby may retain the URL with an incomplete
extraction flag; the extension reports that explicitly rather than claiming
full-text capture succeeded. Use the reader to inspect and retry extraction.
If a request times out, reopen the popup to check whether it completed before
retrying. There is no offline queue or automatic save on navigation.

## Privacy and permissions

See `privacy.html`, also bundled with the extension. API tokens stay in local
extension storage, not browser sync, and are never returned to the popup or
injected into websites. Authenticated requests originate only in the background
worker/event page, omit browser cookies, and target the configured instance.
No content script runs automatically. No analytics or remote code is loaded.

Opening the popup sends the current URL to the configured instance for duplicate
detection. Explicit page capture can include private article content: review
the page before choosing it. Optional host access is requested only for your
chosen instance's hostname; browser host grants include all ports, although
requests use only the exact configured origin. Disconnect removes local
credentials and the instance permission. Also revoke the token in Wallaby
Settings to invalidate it server-side.

## Development and verification

```sh
npm run test -- lib/browser-extension.test.ts
npm run extension:build
npm run extension:lint
WALLABY_E2E_PORT=3330 npm run test:extension
npx playwright install firefox
# Install Mozilla geckodriver on PATH, or set GECKODRIVER_PATH to its executable.
WALLABY_E2E_PORT=3330 npm run test:extension:firefox
```

The browser acceptance suite loads the Chrome extension into a persistent
Chromium context and exercises its UI against an isolated production Wallaby
server and database. It invokes the real browser action for the `activeTab`
grant, then displays the popup UI in a tab because native toolbar popup targets
are not exposed to Playwright. Only that UI's current-tab query is substituted.
Native host-permission dialogs are pregranted in disposable manifest copies.
The Firefox suite uses Mozilla geckodriver 0.37.1+ to temporarily install the
actual Firefox bundle, exercise its connection UI and event-page API, and verify
live page capture, metadata changes, deletion, and token revocation. Gecko's
system-access mode is used only to open the extension's own settings page.
Firefox packaging is also checked with Mozilla's `addons-linter`. Store signing,
review, and a final manual toolbar/permissions check remain necessary before
store distribution.
Both browser bundles use the same typed source and API client, with separate
Manifest V3 service-worker (Chrome) and event-page (Firefox) backgrounds.
Mozilla's validator reports two upstream Readability `innerHTML` warnings in
`capture.js`: those assignments operate on the detached document clone, never
the live page or extension UI. Saved HTML is sanitized again by the server.
