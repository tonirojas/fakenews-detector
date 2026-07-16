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
| Proveedor de IA | Any supported provider or a custom OpenAI-compatible endpoint |
| URL base | Optional override — leave empty to use the official URL |
| Clave de API | Your provider's API key — stored locally only |
| Modelo | Speed-ranked dropdown or free-text for open catalogs |
| Clave STT | Optional Whisper key for audio transcription |
| URL base STT | Optional Whisper endpoint (default: OpenAI) |
| Modelo STT | Optional transcription model (default: `whisper-1`) |
| Intervalo de análisis | Minimum seconds between API calls (default: 12 s) |

---

## Supported providers

### Built-in presets

| Group | Provider | Protocol | Default model | Get a key |
|---|---|---|---|---|
| Principales | **Anthropic (Claude)** | anthropic | claude-haiku-4-5-20251001 | [console.anthropic.com](https://console.anthropic.com/settings/keys) |
| Principales | **OpenAI (ChatGPT)** | openai | gpt-4o-mini | [platform.openai.com](https://platform.openai.com/api-keys) |
| Principales | **Google Gemini** | gemini | gemini-2.0-flash | [aistudio.google.com](https://aistudio.google.com/apikey) |
| China | **DeepSeek** | openai-compat | deepseek-chat | [platform.deepseek.com](https://platform.deepseek.com/api_keys) |
| China | **Qwen / Alibaba** | openai-compat | qwen-turbo | [bailian.console.alibabacloud.com](https://bailian.console.alibabacloud.com/) |
| China | **Kimi / Moonshot** | openai-compat | kimi-k2-turbo-preview | [platform.moonshot.ai](https://platform.moonshot.ai/console/api-keys) |
| China | **GLM / Zhipu** | openai-compat | glm-4.5-air | [open.bigmodel.cn](https://open.bigmodel.cn/usercenter/apikeys) |
| China | **MiniMax** | openai-compat | MiniMax-M2 | [platform.minimax.io](https://platform.minimax.io/) |
| Otros / Local | **Grok / xAI** | openai-compat | grok-4-fast | [console.x.ai](https://console.x.ai/) |
| Otros / Local | **Mistral AI** | openai-compat | mistral-small-latest | [console.mistral.ai](https://console.mistral.ai/api-keys/) |
| Otros / Local | **Groq (Llama)** | openai-compat | llama-3.3-70b-versatile | [console.groq.com](https://console.groq.com/keys) |
| Otros / Local | **OpenRouter** | openai-compat | free text | [openrouter.ai](https://openrouter.ai/settings/keys) |
| Otros / Local | **Ollama (local)** | openai-compat | free text | no key needed |
| Otros / Local | **Personalizado** | openai-compat | free text | depends on provider |

### Use any AI — the OpenAI-compatible standard

The **OpenAI chat completions API** (`POST /chat/completions`) has become the de-facto interoperability standard for LLMs. Any provider that implements it works with this extension — select **Personalizado** and enter the base URL.

The extension sends `response_format: {type:"json_object"}` on the first request and automatically retries without it if the provider rejects it, so you get clean JSON parsing across the widest range of backends.

### Custom base URL — mainland China endpoints

Providers with China-international and China-mainland endpoints differ:

| Provider | International | Mainland China (override in URL base field) |
|---|---|---|
| Qwen | dashscope-intl.aliyuncs.com | dashscope.aliyuncs.com |
| Kimi | api.moonshot.ai | api.moonshot.cn |
| GLM | api.z.ai | open.bigmodel.cn |
| MiniMax | api.minimax.io | api.minimaxi.com |

Set the **URL base** field to the mainland endpoint to switch without changing your API key.

> Models that emit `<think>` reasoning blocks inline (e.g. MiniMax M2.x) are handled automatically — the extension strips those blocks before JSON parsing.

### Ollama — local, fully private

With Ollama, page content goes only to your local Ollama server (`http://localhost:11434`) — nothing leaves your machine. No API key is required. Install a model with `ollama pull llama3.2`, enter `llama3.2` in the model field, and set the base URL to `http://localhost:11434/v1`.

### OpenRouter — one key, many models

OpenRouter provides access to hundreds of models through a single OpenAI-compatible endpoint. Enter any model identifier available on [openrouter.ai/models](https://openrouter.ai/models) in the model field (e.g. `deepseek/deepseek-chat`, `google/gemini-flash-1.5`).

---

## Audio transcription (STT)

| Main provider | STT used | Requirement |
|---|---|---|
| **OpenAI** | Whisper (same key) | None — main key covers it |
| **Gemini** | Gemini multimodal | None — main key covers it |
| Any other provider | OpenAI-compatible Whisper | Set a key in **Clave STT** |
| Whisper via Groq (fast) | Groq Whisper | Set Groq key + URL `https://api.groq.com/openai/v1`, model `whisper-large-v3-turbo` |

> **Firefox:** Audio capture requires `tabCapture` and `offscreen` APIs which are unavailable in Firefox. The audio button is disabled automatically and a hint is shown.

---

## Audio transcription without a token (self-hosted Whisper)

A hosted, free, no-token STT service with Whisper-grade latency and reliability effectively does not exist. The token-free path is self-hosting. Groq offers a fast, free-tier Whisper API but still requires a (free) API key.

Self-hosting recipe: run any OpenAI-compatible Whisper server, then point the **STT base URL** field at it and leave the **STT key** field empty.

### Local Docker — CPU (speaches)

```bash
docker run \
  --publish 8000:8000 \
  --volume hf-hub-cache:/home/ubuntu/.cache/huggingface/hub \
  --env WHISPER__MODEL=Systran/faster-whisper-small \
  --detach \
  ghcr.io/speaches-ai/speaches:latest-cpu
```

| Field | Value |
|---|---|
| STT base URL | `http://localhost:8000/v1` |
| STT model | `Systran/faster-whisper-small` |
| STT key | *(leave empty)* |

For NVIDIA GPU acceleration, swap the tag to `ghcr.io/speaches-ai/speaches:latest-cuda`.

Alternative image: **`hwdsl2/whisper-server`** also exposes an OpenAI-compatible `/v1/audio/transcriptions` endpoint and works the same way.

### Remote VPS

Same setup, but the endpoint **must be https** — for example, behind an nginx or Caddy reverse-proxy with a TLS certificate. The extension rejects non-https, non-localhost STT URLs to prevent captured audio from being sent over cleartext.

> **IPv6 note:** `http` is allowed only for the literal hostnames `localhost`, `127.0.0.1`, and `[::1]`. If your Docker instance binds to the IPv6 loopback address, use `http://[::1]:8000/v1`.

### Performance notes

- faster-whisper (CTranslate2) is up to ~4× faster than the reference Whisper implementation.
- On CPU: use `int8` quantization and the `small` or `medium` model. A 6 s audio chunk processed in near-real time may lag on weak hardware; GPU is recommended for smooth real-time transcription.

> **Security:** with a self-hosted STT server, the captured audio goes only to the server you control — not to any third-party API.

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
| API key required | No call is made if no key is configured (skipped for Ollama) |
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

For providers with no built-in catalog (OpenRouter, Ollama, custom), type the model ID directly in the model field.

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
                                           |  Protocol adapters: |
                                           |  anthropic / openai |
                                           |  (compat) / gemini  |
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
- **Audio transcription:** Requires Whisper (any compatible endpoint) or Gemini. Unavailable on Firefox.
- **Service worker lifecycle:** Chrome may suspend the background service worker between interactions. State is mirrored to `chrome.storage.session` to survive restarts.

---

## Privacy

- Page text and tab audio are sent directly to your chosen LLM provider's API.
- With **Ollama**, page content goes only to your local Ollama server — nothing leaves your machine.
- API keys are stored in `chrome.storage.local` on this device only.
- No data passes through any server operated by this extension.
- Keys are never logged to the console.

---

## Icons

Icons are generated from `FakeNewsDetectorIcon.png` (source asset, transparent background) into the `icons/` folder at 16, 32, 48, and 128 px.
