# FakeNews Detector

An AI-assisted claim-checking Chrome extension (Manifest V3).

> **Important:** This extension is a decision-support aid, NOT an infallible lie detector.
> LLM outputs can be wrong, biased, or outdated. Always verify critical claims independently.

---

## Features

- Fact-checks **news articles and text pages** by extracting visible paragraph text and sending it to your chosen LLM provider.
- Fact-checks **audio/video tabs** (YouTube, streaming sites, Instagram Reels/Stories) by capturing tab audio, transcribing it with Whisper or Gemini, then running the same claim-analysis pipeline.
- Shows a **colored glow border** around the page:
  - Green — claims appear true
  - Amber — uncertain / possible misinformation
  - Red (pulsing) — confirmed fake claims detected
  - Gray — not enough data to verify
- Displays a **Spanish-language banner pill** at the top of the page with the verdict summary.
- **Side panel** shows each individual claim, confidence score, reasoning, and source links.
- All analysis stays between your browser and the LLM API — no third-party relay server.

---

## Install (Developer Mode)

1. Clone or download this repository.
2. Open Chrome and navigate to `chrome://extensions`.
3. Enable **Developer mode** (top-right toggle).
4. Click **Load unpacked** and select the project folder (`FAKENEWS-DETECTOR-PROJECT`).
5. The extension icon (Chrome default) appears in your toolbar.

> No build step required. Vanilla ES modules only.

---

## Configuration

Open the extension options page (click the toolbar icon → **Configuración**) to set:

| Setting | Description |
|---|---|
| Provider | Anthropic (Claude), OpenAI (GPT), or Google Gemini |
| API Key | Your provider's API key — stored locally only |
| Model | Free-text model name (defaults shown per provider) |
| OpenAI STT Key | Optional Whisper key when using Anthropic as main provider |
| Check interval | Minimum seconds between API calls (default: 12 s) |

### Provider defaults

| Provider | Default model |
|---|---|
| Anthropic | `claude-sonnet-4-5` |
| OpenAI | `gpt-4o-mini` |
| Google Gemini | `gemini-2.0-flash` |

The model field is editable — change it to any valid model ID without touching the code.

### Audio transcription requirements

| Main provider | STT used | Requirement |
|---|---|---|
| OpenAI | Whisper (same key) | None — main key covers it |
| Anthropic | Whisper | Requires separate OpenAI STT key |
| Anthropic (no STT key) | — | Audio analysis unavailable |
| Gemini | Gemini multimodal | None — main key covers it |

---

## How It Works

```
┌─────────────┐   START_TEXT / START_AUDIO   ┌──────────────────┐
│   Popup     │──────────────────────────────▶│  background.js   │
│  (toolbar)  │◀──── VERDICT_UPDATE ──────────│  (service worker)│
└─────────────┘                               └────────┬─────────┘
                                                       │  factCheck()
                                            ┌──────────▼──────────┐
                                            │   lib/providers.js   │
                                            │  Anthropic / OpenAI  │
                                            │  / Gemini API calls  │
                                            └─────────────────────┘

┌─────────────┐  EXTRACT_TEXT / PAGE_TEXT    ┌──────────────────┐
│ content.js  │◀────────────────────────────▶│  background.js   │
│ (page DOM)  │◀──── VERDICT_UPDATE ─────────│                  │
│  + overlay  │                               └────────┬─────────┘
└─────────────┘                                        │  AUDIO_CHUNK
                                            ┌──────────▼──────────┐
┌─────────────┐  VERDICT_UPDATE broadcast   │  offscreen/          │
│  Side panel │◀───────────────────────────▶│  offscreen.js        │
│ (claims UI) │                              │  (getUserMedia +     │
└─────────────┘                              │   MediaRecorder)     │
                                             └─────────────────────┘
```

### Text flow
1. User clicks "Analizar texto de la página" in the popup.
2. Background tells the content script to extract visible text (prefers `<article>` → `<main>` → `<body>`).
3. Background throttles calls (respects interval + text hash deduplication).
4. Result is broadcast as `VERDICT_UPDATE` to the content script (overlay) and side panel.

### Audio flow
1. User clicks "Analizar audio/vídeo".
2. Background calls `chrome.tabCapture.getMediaStreamId` and opens an offscreen document.
3. Offscreen document captures the tab stream, routes it through an `AudioContext` (so the user keeps hearing it), and MediaRecorder slices it every 6 s.
4. Each chunk is base64-encoded and sent to background as `AUDIO_CHUNK`.
5. Background transcribes (Whisper or Gemini) then fact-checks accumulated transcript segments.

---

## Limitations

- **Knowledge cutoff:** The LLM cannot verify events that occurred after its training cutoff. Such claims are automatically labeled "Sin datos suficientes para verificar".
- **Source accuracy:** Source links in the side panel are generated by the LLM and may be imprecise or hallucinated. Treat them as starting points, not authoritative citations.
- **Audio transcription:** Requires Whisper (OpenAI) or Gemini as provider. Anthropic alone does not support audio.
- **Overlay scope:** The glow border covers the browser viewport content area. It does not affect the OS window chrome or other applications.
- **API cost:** Every analysis call consumes API tokens. Increase the check interval to reduce costs. Check your provider's pricing before heavy use.
- **Service worker lifecycle:** Chrome may suspend the background service worker between interactions. State is mirrored to `chrome.storage.session` to survive restarts.

---

## Privacy

- Page text and tab audio are sent directly to your chosen LLM provider's API.
- API keys are stored in `chrome.storage.local` on this device only.
- No data passes through any server operated by this extension.
- Keys are never logged to the console.

---

## Icons

No icons are bundled. Chrome displays a default puzzle-piece icon in the toolbar.
To add custom icons, place `icon16.png`, `icon48.png`, and `icon128.png` in an `icons/` folder and add the `icons` field to `manifest.json`.
