/**
 * content/content.js
 * Injected into all frames=false pages at document_idle.
 * NOT an ES module — uses classic script context.
 *
 * Responsibilities:
 *  1. Listen for EXTRACT_TEXT → collect page text → send PAGE_TEXT to background
 *  2. Listen for VERDICT_UPDATE → show/update overlay + banner
 *  3. Listen for ANALYSIS_ERROR → show error banner
 *  4. Listen for REMOVE_OVERLAY → remove overlay
 *
 * NOTE: Spanish strings are inlined here because content scripts cannot
 * import ES modules. Keep in sync with lib/strings.js.
 */

// Cross-browser API shim (mirrors lib/webext.js — cannot import modules here)
const api = globalThis.browser ?? globalThis.chrome;

// ---------------------------------------------------------------------------
// Inline verdict UI map (mirrors lib/strings.js VERDICT_UI)
// ---------------------------------------------------------------------------
const VERDICT_UI = {
  true: { label: "Lo que dice es verdad", colorClass: "fnd-green" },
  uncertain: { label: "Peligro, podría estar mintiendo", colorClass: "fnd-amber" },
  false: { label: "Peligro, FAKE NEW confirmada", colorClass: "fnd-red" },
  unverifiable: { label: "Sin datos suficientes para verificar", colorClass: "fnd-gray" },
};

function getBannerText(verdict) {
  const ui = VERDICT_UI[verdict] ?? VERDICT_UI.unverifiable;
  if (verdict === "false" || verdict === "uncertain") {
    return `Peligro, posible FAKE NEW — ${ui.label}`;
  }
  return ui.label;
}

// ---------------------------------------------------------------------------
// Overlay management
// ---------------------------------------------------------------------------
let overlayRoot = null;
let bannerEl = null;

function ensureOverlay() {
  if (overlayRoot && document.body.contains(overlayRoot)) return;

  overlayRoot = document.createElement("div");
  overlayRoot.id = "fnd-overlay-root";
  document.body.appendChild(overlayRoot);

  bannerEl = document.createElement("div");
  bannerEl.id = "fnd-banner";
  bannerEl.setAttribute("role", "status");
  bannerEl.setAttribute("aria-live", "polite");

  const closeBtn = document.createElement("button");
  closeBtn.id = "fnd-banner-close";
  closeBtn.title = "Cerrar aviso";
  closeBtn.textContent = "×";
  closeBtn.addEventListener("click", () => removeBanner());

  bannerEl.appendChild(closeBtn);
  document.body.appendChild(bannerEl);
}

function updateOverlay(verdict) {
  if (!overlayRoot) return;
  const allClasses = ["fnd-green", "fnd-amber", "fnd-red", "fnd-gray"];
  overlayRoot.classList.remove(...allClasses);
  bannerEl.classList.remove(...allClasses);

  const ui = VERDICT_UI[verdict] ?? VERDICT_UI.unverifiable;
  overlayRoot.classList.add(ui.colorClass);
  bannerEl.classList.add(ui.colorClass);
}

function updateBannerText(verdict) {
  if (!bannerEl) return;
  // Preserve close button
  const closeBtn = bannerEl.querySelector("#fnd-banner-close");
  bannerEl.textContent = getBannerText(verdict);
  if (closeBtn) bannerEl.appendChild(closeBtn);
}

function showErrorBanner(message) {
  ensureOverlay();
  updateOverlay("uncertain");
  if (bannerEl) {
    const closeBtn = bannerEl.querySelector("#fnd-banner-close");
    bannerEl.textContent = `⚠ ${message}`;
    if (closeBtn) bannerEl.appendChild(closeBtn);
  }
}

function removeBanner() {
  bannerEl?.remove();
  bannerEl = null;
}

function removeOverlay() {
  overlayRoot?.remove();
  overlayRoot = null;
  removeBanner();
}

// ---------------------------------------------------------------------------
// Text extraction
// ---------------------------------------------------------------------------
function extractPageText() {
  // Prefer article > main > body
  const root =
    document.querySelector("article") ??
    document.querySelector("main") ??
    document.body;

  const tags = root.querySelectorAll("p, h1, h2, h3, h4, h5, h6, li, blockquote");
  let parts = [];
  for (const el of tags) {
    const t = el.innerText?.trim();
    if (t) parts.push(t);
  }

  // Also include user selection if present
  const selection = window.getSelection()?.toString().trim();
  if (selection) parts.unshift(`[Selección del usuario]: ${selection}`);

  return parts.join("\n").slice(0, 8000);
}

// ---------------------------------------------------------------------------
// Message listener
// Guard all api.runtime calls — content scripts can become orphaned
// when the extension is reloaded (context invalidated).
// ---------------------------------------------------------------------------
function safeSendMessage(message) {
  try {
    api.runtime.sendMessage(message).catch(() => {});
  } catch {
    // Extension context invalidated — nothing we can do
  }
}

function setupMessageListener() {
  try {
    api.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      switch (message.type) {
        case "EXTRACT_TEXT": {
          const text = extractPageText();
          safeSendMessage({ type: "PAGE_TEXT", text });
          // Also use sendResponse for the immediate call path
          try { sendResponse({ ok: true }); } catch { /* ignore */ }
          break;
        }

        case "VERDICT_UPDATE": {
          ensureOverlay();
          updateOverlay(message.overall?.verdict ?? "unverifiable");
          updateBannerText(message.overall?.verdict ?? "unverifiable");
          break;
        }

        case "ANALYSIS_ERROR": {
          showErrorBanner(message.message ?? "Error desconocido");
          break;
        }

        case "REMOVE_OVERLAY": {
          removeOverlay();
          break;
        }
      }
      return false;
    });
  } catch (err) {
    // If context was already invalidated at setup, ignore
    console.warn("[FakeNews Detector] Could not attach message listener:", err.message);
  }
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
setupMessageListener();
