export function extensionManifest(target: "chrome" | "firefox") {
  return {
    manifest_version: 3,
    name: "Wallaby",
    version: "0.1.0",
    description: "A personal reading space. Save articles, collect ideas, and return to what matters.",
    homepage_url: "https://github.com/vibewatch/Wallaby",
    icons: { "16": "icons/16.png", "32": "icons/32.png", "48": "icons/48.png", "128": "icons/128.png" },
    action: {
      default_title: "Save to Wallaby",
      default_popup: "popup.html",
      default_icon: { "16": "icons/16.png", "32": "icons/32.png" },
    },
    background: target === "chrome"
      ? { service_worker: "background.js" }
      : { scripts: ["background.js"] },
    permissions: ["activeTab", "storage", "contextMenus", "scripting"],
    optional_host_permissions: ["https://*/*", "http://*/*"],
    options_ui: { page: "options.html", open_in_tab: true },
    commands: { _execute_action: { suggested_key: { default: "Alt+Shift+W" }, description: "Save to Wallaby" } },
    content_security_policy: { extension_pages: "script-src 'self'; object-src 'none'; base-uri 'none'" },
    ...(target === "chrome" ? { minimum_chrome_version: "116" } : {
      browser_specific_settings: {
        gecko: {
          id: "wallaby@huangyingting.github.io",
          strict_min_version: "142.0",
          data_collection_permissions: { required: ["authenticationInfo", "browsingActivity", "websiteContent"] },
        },
      },
    }),
  };
}
