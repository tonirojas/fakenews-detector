![Fake News Detector — browser extension banner](FakeNewsDetectorCover.jpg)

> AI-powered claim fact-checker for Chrome, Edge, and Firefox — detect misinformation as you browse.

# FakeNews Detector

An AI-assisted claim-checking browser extension (Manifest V3).

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
- **Side panel / sidebar** shows each individual claim, confidence score, reasoning, and source links.
- **Day/night theme** with auto, light, and dark modes — toggle from the popup header or set in Options.
- All analysis stays between your browser and the LLM API — no third-party relay server.

---

## Supported browsers & platforms

| Browser / Platform | Text analysis | Audio capture | Panel / sidebar | Notes |
|---|---|---|---|---|
| **Chrome desktop** | Full | Full (tabCapture) | Built-in side panel | Requires Developer Mode |
| **Edge desktop** | Full | Full (tabCapture) | Built-in side panel | Load via `edge://extensions` |
| **Firefox desktop** | Full | — API unavailable | Sidebar (`sidebar_action`) | Build with `python scripts/build_firefox.py`; host perms opt-in in `about:addons` |
| **Firefox for Android** | Full | — | Panel opens as a tab | Requires AMO signing or Firefox Nightly + custom extension collection for permanent install |
| **Safari / iOS** | Requires Xcode conversion | — | — | Use `xcrun safari-web-extension-converter` on macOS; the capability-gated codebase is prepared for this path |
| Chrome / Edge on Android | — | — | — | Extensions not supported by these browsers on Android |
| Chrome on iOS | — | — | — | Extensions are not supported by Chrome on iOS |

> **Note on iOS:** The only extension path on iOS is Safari Web Extension, which requires conversion via Xcode on macOS and distribution through the App Store or TestFlight.

---

## Install (Developer Mode — Chrome / Edge)

1. Clone or download this repository.
2. Open Chrome (`chrome://extensions`) or Edge (`edge://extensions`).
3. Enable **Developer mode** (top-right toggle).
4. Click **Load unpacked** and select the project folder (`FAKENEWS-DETECTOR-PROJECT`).
5. The extension icon appears in the toolbar. Click it to open the popup.

> No build step required. Vanilla ES modules only.

---

## Building for Firefox

Run the build script (Python 3, no dependencies beyond stdlib):

```
python scripts/build_firefox.py
```

Output is written to `dist/firefox/` (gitignored).

### Loading in Firefox desktop

1. Navigate to `about:debugging` → **This Firefox** → **Load Temporary Add-on**.
2. Select `dist/firefox/manifest.json`.

> **Temporary add-ons** are removed when Firefox restarts. For a permanent non-signed install, use **Firefox Nightly** and add the extension to a [custom extension collection](https://support.mozilla.org/en-US/kb/use-extensions-android).

### Host permissions on Firefox

Firefox treats host permissions as opt-in by default. After loading the extension, go to `about:addons` → the extension → **Permissions** tab and enable the required domains if the extension does not trigger for a site.

---

## Configuration

Open the extension options (click the toolbar icon → **Configuración**, or right-click the icon → **Options**) to set:

| Setting | Description |
|---|---|
| Tema | Auto (system), Claro (light), or Oscuro (dark) |
| Provider | Anthropic (Claude), OpenAI (GPT), or Google Gemini |
| API Key | Your provider's API key — stored locally only |
| Model | Speed-ranked dropdown with custom override |
| OpenAI STT Key | Optional Whisper key when using Anthropic as main provider |
| Check interval | Minimum seconds between API calls (default: 12 s) |

### Provider defaults

| Provider | Default model | Tier |
|---|---|---|
| Anthropic | `claude-haiku-4-5-20251001` | Fast |
| OpenAI | `gpt-4o-mini` | Fast |
| Google Gemini | `gemini-2.0-flash` | Fast |

### Audio transcription requirements

| Main provider | STT used | Requirement |
|---|---|---|
| OpenAI | Whisper (same key) | None — main key covers it |
| Anthropic | Whisper | Requires separate OpenAI STT key |
| Anthropic (no STT key) | — | Audio analysis unavailable |
| Gemini | Gemini multimodal | None — main key covers it |

> **Firefox:** Audio capture requires `tabCapture` and `offscreen` APIs which are unavailable in Firefox. The audio button is disabled automatically and a hint is shown.

---

## Theming

The extension supports three theme modes selectable in **Configuración**:

| Mode | Label | Behaviour |
|---|---|---|
| `auto` (default) | Automático (sistema) | Follows the OS light/dark preference via `matchMedia` |
| `light` | Claro | Always light |
| `dark` | Oscuro | Always dark |

A quick-toggle sun/moon button in the popup header lets you switch between light and dark without opening Settings. Theme changes apply immediately to all open extension surfaces (popup, options page, side panel).

---

## Automatic mode

Enable **Protección automática** in the popup to have the extension fact-check every page you visit without clicking a button.

### What it does

When active, the background service worker listens for tab switches and page loads. It waits ~2.5 s after navigation settles (debounce), then runs the exact same text-analysis pipeline as the manual "Analizar texto" button.

### Why audio stays manual

`tabCapture` requires an explicit per-tab user gesture. There is no way for a background service worker to start audio capture autonomously. Audio analysis must always be started from the popup.

### Cost guards

| Guard | Detail |
|---|---|
| API key required | No call is made if no key is configured |
| HTTP/HTTPS only | `chrome://`, `file://`, `about:`, `data:`, and web-store URLs are skipped entirely |
| 10-minute URL dedupe | The same URL is not re-analyzed until 10 minutes have elapsed |
| Single in-flight | If a request is already pending, the trigger is dropped |
| Check interval | Respects the same minimum-seconds-between-calls setting as manual mode |

---

## Choosing a model

| Tier | Label | When to use |
|---|---|---|
| Fast | Recomendado para tiempo real | Default. Lowest latency and cost. Best for auto mode. |
| Balanced | Equilibrado | Better reasoning at moderate cost. |
| Quality | Maxima calidad (mas lento y caro) | Maximum accuracy. Slower and significantly more expensive. |

Select **Otro (personalizado)…** to type an exact model ID not in the list.

---

## How It Works

```
+-------------+   START_TEXT / START_AUDIO   +------------------+
|   Popup     +----------------------------->+  background.js   |
|  (toolbar)  +<----- VERDICT_UPDATE --------+  (service worker)|
+-------------+                              +--------+---------+
                                                      |  factCheck()
                                           +----------v----------+
                                           |   lib/providers.js  |
                                           |  Anthropic / OpenAI |
                                           |  / Gemini API calls |
                                           +---------------------+

+-------------+  EXTRACT_TEXT / PAGE_TEXT   +------------------+
| content.js  +<---------------------------->+  background.js   |
| (page DOM)  +<----- VERDICT_UPDATE --------+                  |
|  + overlay  |                              +--------+---------+
+-------------+                                       |  AUDIO_CHUNK
                                           +----------v----------+
+--------------+  VERDICT_UPDATE broadcast |  offscreen/         |
|  Side panel  +<------------------------->+  offscreen.js       |
| (claims UI)  |                           |  (getUserMedia +    |
+--------------+                           |   MediaRecorder)    |
                                           +---------------------+
```

---

## Limitations

- **Knowledge cutoff:** The LLM cannot verify events after its training cutoff. Such claims are labeled "Sin datos suficientes para verificar".
- **Source accuracy:** Source links are generated by the LLM and may be imprecise or hallucinated.
- **Audio transcription:** Requires Whisper (OpenAI) or Gemini. Anthropic alone does not support audio. Unavailable on Firefox.
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
