// theme-preload.js — classic (non-module) script, loaded synchronously in <head>.
//
// Pre-paint theme: read the last resolved theme from sessionStorage and set the
// data-theme attribute before first paint, preventing a flash of the wrong theme
// on repeat opens of popup / options / side panel.
//
// This lives in an external file (not an inline <script>) because the Manifest V3
// content security policy is `script-src 'self'` — inline scripts are blocked.
try {
  var t = sessionStorage.getItem("theme_resolved");
  if (t === "dark" || t === "light") {
    document.documentElement.setAttribute("data-theme", t);
  }
} catch (e) {
  // sessionStorage may be unavailable; the async theme init still runs later.
}
