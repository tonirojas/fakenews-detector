/**
 * offscreen/offscreen.js
 * Runs in the offscreen document — has access to getUserMedia and MediaRecorder.
 * One recorder at a time. Receives OFFSCREEN_START / OFFSCREEN_STOP from background.js.
 *
 * Flow:
 *   1. background sends OFFSCREEN_START {streamId, tabId}
 *   2. We open the tab stream via getUserMedia with chromeMediaSourceId
 *   3. Route through AudioContext so the user keeps hearing the tab audio
 *   4. MediaRecorder slices audio every 6000ms → base64 → AUDIO_CHUNK to background
 *   5. On OFFSCREEN_STOP: stop recorder + release tracks
 */

let mediaRecorder = null;
let audioContext  = null;
let activeTabId   = null;

// ---------------------------------------------------------------------------
// Message listener
// ---------------------------------------------------------------------------
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === "OFFSCREEN_START") {
    startCapture(message.streamId, message.tabId)
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true; // keep channel open for async
  }

  if (message.type === "OFFSCREEN_STOP") {
    stopCapture();
    sendResponse({ ok: true });
    return false;
  }
});

// ---------------------------------------------------------------------------
// Start capture
// ---------------------------------------------------------------------------
async function startCapture(streamId, tabId) {
  // Stop any previous session first
  stopCapture();

  activeTabId = tabId;

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      mandatory: {
        chromeMediaSource: "tab",
        chromeMediaSourceId: streamId,
      },
    },
    video: false,
  });

  // Route through AudioContext → destination so the tab audio keeps playing
  audioContext = new AudioContext();
  const source = audioContext.createMediaStreamSource(stream);
  source.connect(audioContext.destination);

  // Set up MediaRecorder
  const mimeType = getSupportedMimeType();
  mediaRecorder = new MediaRecorder(stream, { mimeType });

  mediaRecorder.addEventListener("dataavailable", (event) => {
    if (!event.data || event.data.size === 0) return;
    blobToBase64(event.data).then((base64) => {
      chrome.runtime.sendMessage({
        type: "AUDIO_CHUNK",
        tabId: activeTabId,
        base64,
        mimeType: event.data.type || mimeType,
      }).catch(() => {
        // Background SW may have restarted — silently ignore
      });
    });
  });

  mediaRecorder.addEventListener("stop", () => {
    // Release tracks
    stream.getTracks().forEach((t) => t.stop());
    if (audioContext) {
      audioContext.close().catch(() => {});
      audioContext = null;
    }
  });

  // Slice every 6 seconds
  mediaRecorder.start(6000);
}

// ---------------------------------------------------------------------------
// Stop capture
// ---------------------------------------------------------------------------
function stopCapture() {
  if (mediaRecorder && mediaRecorder.state !== "inactive") {
    try { mediaRecorder.stop(); } catch { /* ignore */ }
  }
  mediaRecorder = null;
  activeTabId   = null;
  // audioContext is closed in the "stop" event handler
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function getSupportedMimeType() {
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/ogg;codecs=opus",
  ];
  for (const mime of candidates) {
    if (MediaRecorder.isTypeSupported(mime)) return mime;
  }
  return "";
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      // result is "data:<mime>;base64,<data>" — strip the prefix
      const result = reader.result;
      const base64 = result.split(",")[1] ?? "";
      resolve(base64);
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}
