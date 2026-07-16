/**
 * lib/theme.js
 * Day/night theme management for all extension UI surfaces.
 *
 * Exports:
 *   applyTheme(doc, themeSetting) — resolves "auto" and sets data-theme on doc.documentElement
 *   initTheme(doc)               — reads storage, applies immediately, subscribes to live updates
 *
 * Theme setting values: "auto" | "light" | "dark"
 * "auto" follows the OS colour scheme via matchMedia("(prefers-color-scheme: dark)").
 */

import { api } from "./webext.js";

/**
 * Resolve the stored setting to a concrete "light" or "dark" value.
 * @param {"auto"|"light"|"dark"} setting
 * @returns {"light"|"dark"}
 */
function resolveTheme(setting) {
  if (setting === "light" || setting === "dark") return setting;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

/**
 * Apply a theme setting to a document by setting data-theme on <html>.
 *
 * @param {Document} doc
 * @param {"auto"|"light"|"dark"} themeSetting
 */
export function applyTheme(doc, themeSetting) {
  doc.documentElement.setAttribute("data-theme", resolveTheme(themeSetting ?? "auto"));
}

/**
 * Initialise live theming for a document:
 *   - Reads the saved theme from storage and applies it as soon as the Promise resolves.
 *   - Subscribes to storage changes so every open surface updates without a page reload.
 *   - Re-resolves "auto" when the OS colour scheme changes.
 *
 * Call as early as possible in the page lifecycle to minimise flash of wrong theme.
 *
 * @param {Document} doc
 */
export function initTheme(doc) {
  let currentSetting = "auto";

  // Apply stored setting as soon as the storage read resolves.
  // Also mirror the resolved value to sessionStorage so the inline pre-paint
  // script can apply it synchronously on the next open of this surface.
  api.storage.local.get(["theme"]).then((data) => {
    currentSetting = data.theme ?? "auto";
    applyTheme(doc, currentSetting);
    try {
      sessionStorage.setItem("theme_resolved", doc.documentElement.getAttribute("data-theme"));
    } catch {}
  });

  // Live-update when the setting changes in any open extension surface
  api.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes.theme) return;
    currentSetting = changes.theme.newValue ?? "auto";
    applyTheme(doc, currentSetting);
    try {
      sessionStorage.setItem("theme_resolved", doc.documentElement.getAttribute("data-theme"));
    } catch {}
  });

  // Re-apply when the OS switches between light and dark (only meaningful in "auto")
  const mq = window.matchMedia("(prefers-color-scheme: dark)");
  mq.addEventListener("change", () => {
    if (currentSetting === "auto") applyTheme(doc, "auto");
  });
}
