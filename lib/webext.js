/**
 * lib/webext.js
 * Cross-browser WebExtension API shim.
 *
 * Firefox exposes a promise-native `browser` namespace; Chrome and Edge use `chrome`.
 * This module unifies them into a single `api` export. All extension JS must import
 * `api` from here instead of referencing `chrome` directly.
 *
 * Chrome-only namespaces (api.offscreen, api.tabCapture, api.sidePanel) must only
 * be accessed after a capability check — never at module top level.
 */

/** Unified extension API — prefers Firefox's promise-native `browser` namespace. */
export const api = globalThis.browser ?? globalThis.chrome;

/**
 * Returns true when tab audio capture and offscreen documents are both available.
 * Both APIs exist in Chrome/Edge but not in Firefox.
 *
 * Guard every call to api.tabCapture and api.offscreen behind this check.
 *
 * @returns {boolean}
 */
export function supportsAudioCapture() {
  return !!(api.tabCapture && api.offscreen);
}

/**
 * Opens the results panel in the most appropriate way for the current browser.
 *
 * Priority:
 *   1. api.sidePanel (Chrome / Edge desktop)
 *   2. api.sidebarAction (Firefox desktop)
 *   3. api.tabs.create fallback (mobile / any browser without a sidebar API)
 *
 * IMPORTANT: Must be called synchronously inside a user-gesture handler so the
 * browser permits the sidePanel / sidebarAction call without a permission error.
 *
 * @param {number} tabId
 * @returns {Promise<void>}
 */
export function openResultsPanel(tabId) {
  if (api.sidePanel) {
    return api.sidePanel.open({ tabId });
  }
  if (api.sidebarAction) {
    return Promise.resolve(api.sidebarAction.open());
  }
  // Fallback: open as a regular browser tab (mobile / browsers without sidebar support)
  return api.tabs.create({ url: api.runtime.getURL("sidepanel/sidepanel.html") });
}
