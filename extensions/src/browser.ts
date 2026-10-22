declare const browser: typeof chrome | undefined;

export const api = typeof browser === "undefined" ? chrome : browser;
