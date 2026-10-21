import type { MetadataRoute } from "next";

/**
 * Web app manifest. Installing Wallaby should feel like opening a reader, so it
 * launches standalone straight into the unread queue, with shortcuts for the
 * things people reach for from a home screen: saving, unread, starred, search.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/entries",
    name: "Wallaby — read it later",
    short_name: "Wallaby",
    description: "Save articles, read them without distraction, and keep a portable copy of what you have read.",
    start_url: "/entries?view=unread",
    scope: "/",
    display: "standalone",
    orientation: "portrait-primary",
    background_color: "#f5f4ed",
    theme_color: "#b74e32",
    categories: ["books", "news", "productivity"],
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icon-maskable-192.png", sizes: "192x192", type: "image/png", purpose: "maskable" },
      { src: "/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
    // Installed on Android, Wallaby appears in the system share sheet. GET keeps
    // the target a pre-filled form; saving still takes an explicit click.
    share_target: {
      action: "/entries/new",
      method: "GET",
      params: { title: "title", text: "text", url: "url" },
    },
    shortcuts: [
      { name: "Save an article", short_name: "Save", url: "/entries/new" },
      { name: "Unread", short_name: "Unread", url: "/entries?view=unread" },
      { name: "Starred", short_name: "Starred", url: "/entries?view=starred" },
      { name: "Search", short_name: "Search", url: "/entries?view=all&focus=search" },
    ],
  };
}
