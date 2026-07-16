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
5. The extension icon appears in your toolbar.

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

| Provider | Default model | Tier |
|---|---|---|
| Anthropic | `claude-haiku-4-5-20251001` | Fast |
| OpenAI | `gpt-4o-mini` | Fast |
| Google Gemini | `gemini-2.0-flash` | Fast |

All three defaults are the fastest (lowest-latency) model for each provider, which is the best choice for automatic mode. Use the **Modelo** dropdown in options to switch to a balanced or quality-tier model. See [Choosing a model](#choosing-a-model) above for guidance.

### Audio transcription requirements

| Main provider | STT used | Requirement |
|---|---|---|
| OpenAI | Whisper (same key) | None — main key covers it |
| Anthropic | Whisper | Requires separate OpenAI STT key |
| Anthropic (no STT key) | — | Audio analysis unavailable |
| Gemini | Gemini multimodal | None — main key covers it |

---

## Automatic mode

Enable **Protección automática** in the popup toolbar to have the extension fact-check every page you visit without clicking a button.

### What it does

When active, the background service worker listens for tab switches and page loads. It waits ~2.5 s after navigation settles (debounce), then runs the exact same text-analysis pipeline as the manual "Analizar texto" button: the content script extracts visible text, the background sends it to your chosen LLM provider, and the overlay plus side panel update with the verdict.

### Why audio stays manual

Chrome's `tabCapture` API requires an explicit, per-tab user gesture to obtain a media stream. There is no way for a background service worker to start audio capture autonomously — attempting to do so would either silently fail or be blocked by the browser. Audio analysis must always be started from the popup.

### Cost guards

Automatic mode applies a layered set of guards before every API call to avoid unexpected charges:

| Guard | Detail |
|---|---|
| API key required | No call is made if no key is configured |
| HTTP/HTTPS only | `chrome://`, `file://`, `about:`, `data:`, and web-store URLs are skipped entirely |
| 10-minute URL dedupe | The same URL is not re-analyzed until 10 minutes have elapsed (even across tab switches) |
| Single in-flight | If a fact-check request is already pending for that tab, the trigger is dropped |
| Check interval | Respects the same minimum-seconds-between-calls setting as manual mode |

Closing a tab removes its URL from the recency map, so reopening the same page always triggers a fresh analysis.

---

## Choosing a model

The options page now shows a speed-ranked dropdown instead of a free-text field.

| Tier | Label | When to use |
|---|---|---|
| Fast | ⚡ Rápido — recomendado para tiempo real | Default. Lowest latency and cost. Best for automatic mode and real-time use. |
| Balanced | Equilibrado | Better reasoning at moderate cost. Suitable for manual analysis of long articles. |
| Quality | Máxima calidad (más lento y caro) | Maximum accuracy. Slower and significantly more expensive — reserve for critical verification. |

**Recommendation:** keep the fast model selected when using automatic mode; the added latency of quality models makes real-time analysis feel sluggish and increases cost proportionally.

If you need a model that is not in the list (e.g. a preview or fine-tuned variant), select **Otro (personalizado)…** and type the exact model ID. The extension stores and uses that ID without modification, and the saved custom value is preserved if you later switch providers and back.

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

Icons are generated from `FakeNewsDetectorIcon.jpg` (source asset) into the `icons/` folder at 16, 32, 48, and 128 px.
