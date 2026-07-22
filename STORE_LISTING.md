# FakeNews Detector — Chrome Web Store Submission Kit

Copy the content from each section directly into the CWS Developer Dashboard.

---

## Short Description (max 132 characters)

**Spanish (ES):**
```
Verifica afirmaciones en artículos, vídeos y redes sociales con tu propia clave de IA. Requiere clave API propia.
```
Character count: 113

**English (EN):**
```
AI fact-checker for news, videos, and social media using your own LLM API key. Runs entirely in your browser.
```
Character count: 110

---

## Detailed Description

### Spanish (ES)

```
FakeNews Detector — verificador de afirmaciones asistido por IA

⚠️ Esta es una herramienta de apoyo a la decisión, NO un detector infalible de mentiras. Los modelos de lenguaje pueden cometer errores. Verifica siempre de forma independiente las afirmaciones críticas.

Requiere tu propia clave de API del proveedor que elijas. Ningún dato pasa por servidores del desarrollador.

────────────────────────────────────────
QUÉ HACE
────────────────────────────────────────
• Analiza el texto de artículos y páginas web: extrae el contenido visible y lo envía a tu proveedor de IA para obtener un veredicto afirmación por afirmación con puntuación de confianza y enlaces de fuentes.

• Analiza audio y vídeo (Chrome y Edge): captura el audio de la pestaña activa (YouTube, streaming, redes sociales), lo transcribe con Whisper o Gemini y aplica el mismo pipeline de verificación.

• Modo vigilante (micrófono): escucha tu micrófono para verificar conversaciones presenciales.

• Protección automática: analiza cada página que visitas en segundo plano sin necesidad de hacer clic.

• Modo silencioso: análisis invisible — sin borde de color ni banner. Recibe alertas en Telegram y por email vía webhook (n8n / Zapier / Make / endpoint propio) cuando detecta contenido de riesgo.

• Panel lateral: muestra cada afirmación con su veredicto, confianza, razonamiento y fuentes. Incluye vistas de Conclusión (resumen de sesión generado por IA) e Historial.

• VU meter en tiempo real durante la captura de audio.

• Tema día/noche (automático, claro u oscuro).

────────────────────────────────────────
PROVEEDORES COMPATIBLES (14)
────────────────────────────────────────
Anthropic (Claude) · OpenAI (ChatGPT) · Google Gemini · DeepSeek · Qwen / Alibaba · Kimi / Moonshot · GLM / Zhipu · MiniMax · Grok / xAI · Mistral · Groq (Llama) · OpenRouter · Ollama (local, sin clave) · Endpoint personalizado

Ollama: el texto va solo a tu servidor local — nada sale de tu máquina.

────────────────────────────────────────
PRIVACIDAD
────────────────────────────────────────
El texto de la página y el audio se envían directamente desde tu navegador a la API del proveedor que tú elegiste, usando tu propia clave. El desarrollador no opera ningún servidor y no recibe ningún dato. Las claves y ajustes se guardan localmente.

Política de privacidad completa: https://tonirojas.github.io/fakenews-detector/privacy.html
```

---

### English (EN)

```
FakeNews Detector — AI-assisted claim fact-checker

⚠️ This is a decision-support aid, NOT an infallible lie detector. Language models can make mistakes. Always verify critical claims independently.

Requires your own API key from the provider you choose. No data passes through the developer's servers.

────────────────────────────────────────
WHAT IT DOES
────────────────────────────────────────
• Text analysis — extracts visible paragraph text from news articles and web pages and sends it to your chosen AI provider for a per-claim verdict with confidence scores and source links.

• Audio/video analysis (Chrome and Edge) — captures the active tab's audio stream (YouTube, streaming sites, social media), transcribes it with Whisper or Gemini, and runs the same claim-checking pipeline.

• Microphone ("vigilante") mode — listens to your microphone to fact-check live, in-person conversations.

• Auto protection — analyzes every page you visit in the background without clicking a button.

• Silent mode — invisible analysis with no colored border or banner. Sends Telegram alerts and email via webhook (n8n / Zapier / Make / custom endpoint) when risky content is detected.

• Side panel — shows each claim with its verdict, confidence, reasoning, and sources. Includes a Conclusion view (AI-written session summary) and a History view.

• Real-time VU meter during audio capture.

• Day/night theme (auto, light, or dark).

────────────────────────────────────────
SUPPORTED PROVIDERS (14)
────────────────────────────────────────
Anthropic (Claude) · OpenAI (ChatGPT) · Google Gemini · DeepSeek · Qwen / Alibaba · Kimi / Moonshot · GLM / Zhipu · MiniMax · Grok / xAI · Mistral · Groq (Llama) · OpenRouter · Ollama (local, no key required) · Custom endpoint

Ollama: page content goes only to your local server — nothing leaves your machine.

────────────────────────────────────────
PRIVACY
────────────────────────────────────────
Page text and audio are sent directly from your browser to the API of the provider you chose, using your own key. The developer operates no server and receives no data. Keys and settings are stored locally.

Full privacy policy: https://tonirojas.github.io/fakenews-detector/privacy.html
```

---

## Single Purpose Statement

Paste this in the "Single purpose" field of the CWS review form:

```
FakeNews Detector has a single purpose: to help users fact-check claims in web page content
(text, audio, and video) by forwarding that content to the AI/LLM provider the user selects,
using the user's own API key, and displaying per-claim verdicts with confidence scores and
source links in the browser's side panel. All analysis runs directly between the user's browser
and the provider they configured. The developer operates no server and receives no data.
```

---

## Per-Permission Justification (CWS review form)

Paste each row into the corresponding permission field in the Developer Dashboard.

| Permission | Justification to paste |
|---|---|
| `storage` | Stores the user's API key, provider selection, model, and settings in `chrome.storage.local` on the user's device only. Also caches per-tab analysis results and URL dedup state in `chrome.storage.session` (cleared when the browser closes). No data is transmitted to external servers. |
| `tabs` | Reads the URL and title of the active tab to (a) run auto/silent-mode background analysis and (b) populate Telegram or webhook alert messages with the page URL and title when a risky verdict is detected. |
| `activeTab` | Reads the visible text content of the page the user explicitly chooses to analyze (manual "Analizar texto" button or background analysis in auto/silent mode). Required to extract article text for the LLM fact-check call. |
| `tabCapture` | Captures the audio stream of the active tab for audio/video fact-checking (YouTube, streaming sites, social media audio). Chrome and Edge only; automatically disabled in Firefox. The audio goes directly to the STT provider the user configures — not to any developer server. |
| `offscreen` | Creates an MV3 offscreen document to process tab audio and microphone input using `MediaRecorder` and `getUserMedia`. Required by the Manifest V3 architecture because these APIs are unavailable in a service worker. |
| `sidePanel` | Displays per-claim analysis results, the session Conclusion view, and the session History view in Chrome's built-in side panel. |
| Host permission `<all_urls>` | Injects the content script on any page the user navigates to so they can choose to fact-check it. Required because the user can browse to any website. Also required for automatic mode and silent mode (user-enabled background analysis): the extension cannot predict which URLs the user will visit. Without `<all_urls>` neither of these opt-in background modes would function. The host permission is exercised only when (a) the user triggers manual analysis or (b) the user has explicitly enabled auto/silent mode. |
| Remote code | **No remote code.** The extension does not load, execute, or inject any JavaScript or other code from external URLs. All code is bundled in the extension package. |

---

## Data-Usage Disclosure Answers

Answer these in the "Data usage" section of the CWS review form.

**Personally identifiable information (PII)** — does the extension collect any of the following?

| Data type | Collected? | How used |
|---|---|---|
| Website content | **Yes** — the text or audio of pages the user analyzes | Sent directly from the user's browser to the AI provider the user selected. The developer never receives or sees this data. |
| Authentication info (API keys) | **Yes** — stored locally in `chrome.storage.local` | Used only to authenticate requests to the user's chosen AI/STT provider. Never transmitted to the developer. |
| Personal communications | No | — |
| Location | No | — |
| Health information | No | — |
| Financial and payment information | No | — |
| Other PII | **Yes** — user-supplied destination email address | Stored locally in `chrome.storage.local` and included in webhook alert payloads sent to the webhook URL the user themselves configured. The developer never receives this address. |

**Certifications:**
- [ ] The data is not sold to third parties.
- [ ] The data is not used or transferred for purposes unrelated to the extension's single purpose.
- [ ] The data is not used or transferred to determine creditworthiness or for lending purposes.

---

## Privacy Policy URL

```
https://tonirojas.github.io/fakenews-detector/privacy.html
```

---

## Assets Checklist

### Required (upload in Developer Dashboard)

| Asset | Status | Notes |
|---|---|---|
| Icon 128×128 | **Ready** | `icons/icon128.png` |
| Icon 48×48 | **Ready** | `icons/icon48.png` |
| Icon 16×16 | **Ready** | `icons/icon16.png` |
| Small promo tile 440×280 | **Ready** | `store_assets/small_promo_440x280.png` — run `python3 scripts/make_store_assets.py` |
| Marquee tile 1400×560 | **Ready** | `store_assets/marquee_1400x560.png` — run `python3 scripts/make_store_assets.py` |
| Screenshots (1280×800 or 640×400) | **To capture** | At least 1 required; see suggested shots below |

### Suggested Screenshots (1280×800)

Capture with DevTools device toolbar set to 1280×800, or with a screen-capture tool.

1. **Article verdict overlay + side panel open:** Navigate to a news article → click "Analizar texto" → wait for analysis → screenshot showing the colored glow border, the verdict banner, and the side panel with claim cards. This is the "hero" shot.

2. **Conclusion view:** After analyzing a page → open side panel → click "Conclusión" → screenshot showing the verdict tally and the AI-written session summary paragraph.

3. **Options/Settings page:** Open the Options page (right-click icon → Options) showing the provider dropdown, API key field, and the Silent Mode + Telegram alert section. Demonstrates configurability without exposing any real key.

### Generated tiles

Run once:
```bash
python3 scripts/make_store_assets.py
```
Output: `store_assets/small_promo_440x280.png` and `store_assets/marquee_1400x560.png`

---

## Known Review Risks

| Risk | Explanation |
|---|---|
| Broad host permission `<all_urls>` | This is the permission most likely to trigger a detailed review. The justification is accurate: the user can navigate to any site, and background modes require it. Prepare to explain that the extension only reads text from pages the user explicitly analyzes or from tabs the user has enabled auto/silent mode for. |
| Strong verdict wording in alerts | The alert message includes the phrase "FAKE NEW confirmada" (from `verdictLabels` in `background.js`). This is the LLM's output label framed as the user's own verdict (the user configured the extension and triggered the analysis). The disclaimer in the UI and in the store listing states clearly that this is a decision-support tool, not an authoritative source. Reviewers may scrutinize this wording — it is cosmetic and can be softened in a future release without changing product logic. Do not change it for this submission without retesting the full alert flow. |
| Audio capture | `tabCapture` + `offscreen` + microphone together form a broad audio pipeline. Be ready to demo each mode and show that audio goes directly to the STT API the user configured, not to any developer endpoint. The privacy policy explains this accurately. |

---

## Microsoft Edge Add-ons

Edge Add-ons accepts the same unpacked zip as Chrome (Manifest V3, same codebase). Submission is free.

1. Zip the project root (excluding `dist/`, `store_assets/`, `node_modules/`, `.git/`, and other dev artifacts).
2. Go to [partner.microsoft.com/en-us/dashboard/microsoftedge](https://partner.microsoft.com/en-us/dashboard/microsoftedge).
3. Create a new extension submission, upload the zip, and use the same descriptions and screenshots.

---

## Firefox AMO (addons.mozilla.org)

Firefox requires a separate build because the manifest differs.

1. Build: `python3 scripts/build_firefox.py` → output in `dist/firefox/`
2. Zip the `dist/firefox/` directory.
3. Submit at [addons.mozilla.org/developers/](https://addons.mozilla.org/en-US/developers/).
4. AMO signing is free; review typically takes 1–7 days.
5. Note: `tabCapture` and `offscreen` are unavailable on Firefox — audio analysis is automatically disabled. Text analysis works fully.
