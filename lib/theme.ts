export const themes = ["auto", "light", "dark"] as const;

export type Theme = (typeof themes)[number];

export const THEME_COOKIE = "wallaby.theme";

/** Narrow an untrusted value (cookie, form field, API body) to a known theme. */
export function parseTheme(value: unknown): Theme {
  return typeof value === "string" && (themes as readonly string[]).includes(value) ? (value as Theme) : "auto";
}

/**
 * Resolve the attribute the server can commit to before hydration. `auto`
 * depends on the client's `prefers-color-scheme`, which no request header
 * reports reliably, so it stays unresolved here and is settled by
 * `themeBootstrapScript` before first paint.
 */
export function themeAttribute(theme: Theme): "light" | "dark" | undefined {
  return theme === "auto" ? undefined : theme;
}

/**
 * Runs synchronously in <head> so the resolved palette is committed before the
 * first paint. Without it an `auto` reader on a dark system sees a light flash.
 * Kept dependency-free and self-contained because it executes before the React
 * bundle loads.
 *
 * The system-change listener re-reads `data-theme-preference` rather than
 * closing over the server-rendered value, so a preference chosen later in the
 * session still wins when the OS palette flips.
 */
export function themeBootstrapScript(theme: Theme): string {
  return `(function(){try{var d=document.documentElement;var m=window.matchMedia("(prefers-color-scheme: dark)");var a=function(){var p=d.dataset.themePreference||"auto";d.dataset.theme=p==="auto"?(m.matches?"dark":"light"):p;};d.dataset.themePreference=${JSON.stringify(theme)};a();if(m.addEventListener)m.addEventListener("change",a);}catch(e){}})();`;
}
