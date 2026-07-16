/**
 * offscreen/offscreen.js — ES module
 * Runs in the offscreen document — has access to getUserMedia and MediaRecorder.
 * One recorder session at a time. Receives OFFSCREEN_START / OFFSCREEN_START_MIC /
 * OFFSCREEN_STOP from background.js.
 *
 * This document is only created when supportsAudioCapture() is true (Chrome / Edge).
 * Firefox never reaches this code path.
 *
 * Flow (tab audio):
 *   1. background sends OFFSCREEN_START {streamId, tabId}
 *   2. We open the tab stream via getUserMedia with chromeMediaSourceId
 *   3. Route through AudioContext so the user keeps hearing the tab audio
 *   4. AnalyserNode feeds the VU level loop (~90 ms intervals → AUDIO_LEVEL)
 *   5. Discrete segments: a fresh MediaRecorder is created per segment, started
 *      with NO timeslice, and stopped after SEGMENT_MS. Every emitted blob is a
 *      complete, self-contained WebM file with its own EBML header — Whisper accepts it.
 *   6. On OFFSCREEN_STOP: stop recording, release stream tracks + AudioContext
 *
 * Flow (mic audio):
 *   1. background sends OFFSCREEN_START_MIC {tabId}
 *   2. We open the mic stream via getUserMedia (no chromeMediaSource constraints)
 *   3. AudioContext for VU analyser only — NOT connected to destination (no feedback)
 *   4. Same discrete-segment + VU pipeline as tab audio
 */

import { api } from "../lib/webext.js";

// ---------------------------------------------------------------------------
// Module-level state
// ---------------------------------------------------------------------------
let mediaRecorder     = null;  // current segment's MediaRecorder
let audioContext      = null;
let activeStream      = null;
let analyser          = null;
let activeTabId       = null;
let capturing         = false;
let segmentTimer      = null;
let vuIntervalId      = null;
let captureGeneration = 0;     // incremented per session to guard stale async events

const SEGMENT_MS = 6000; // recording segment length in milliseconds

// ---------------------------------------------------------------------------
// Message listener
// ---------------------------------------------------------------------------
api.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === "OFFSCREEN_START") {
    startCapture(message.streamId, message.tabId)
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true; // keep channel open for async
  }

  if (message.type === "OFFSCREEN_START_MIC") {
    startMicCapture(message.tabId)
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (message.type === "OFFSCREEN_STOP") {
    stopCapture();
    sendResponse({ ok: true });
    return false;
  }
});

// ---------------------------------------------------------------------------
// Tab audio capture
// ---------------------------------------------------------------------------
async function startCapture(streamId, tabId) {
  stopCapture(); // tear down any previous session first

  const gen = ++captureGeneration;
  activeTabId = tabId;
  capturing   = true;

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      mandatory: {
        chromeMediaSource: "tab",
        chromeMediaSourceId: streamId,
      },
    },
    video: false,
  });

  // Guard: stopCapture() may have been called while awaiting getUserMedia
  if (!capturing || captureGeneration !== gen) {
    stream.getTracks().forEach((t) => t.stop());
    return;
  }

  activeStream = stream;

  // Route through AudioContext → destination so the tab audio keeps playing
  audioContext = new AudioContext();
  const source = audioContext.createMediaStreamSource(stream);
  source.connect(audioContext.destination);

  // VU analyser — silent side-chain, not connected to destination
  analyser = audioContext.createAnalyser();
  analyser.fftSize = 256;
  source.connect(analyser);

  startVuLoop("tab");

  const mimeType = getSupportedMimeType();
  startSegment(stream, mimeType, gen);
}

// ---------------------------------------------------------------------------
// Microphone capture
// ---------------------------------------------------------------------------
async function startMicCapture(tabId) {
  stopCapture(); // tear down any previous session first

  const gen = ++captureGeneration;
  activeTabId = tabId;
  capturing   = true;

  // Plain mic — no chromeMediaSource constraints
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });

  // Guard: stopCapture() may have been called while awaiting getUserMedia
  if (!capturing || captureGeneration !== gen) {
    stream.getTracks().forEach((t) => t.stop());
    return;
  }

  activeStream = stream;

  // AudioContext for VU analyser only.
  // DO NOT connect source to destination — prevents speaker feedback / echo.
  audioContext = new AudioContext();
  const source = audioContext.createMediaStreamSource(stream);

  analyser = audioContext.createAnalyser();
  analyser.fftSize = 256;
  source.connect(analyser);

  startVuLoop("mic");

  const mimeType = getSupportedMimeType();
  startSegment(stream, mimeType, gen);
}

// ---------------------------------------------------------------------------
// Discrete segment recording
//
// Creates a FRESH MediaRecorder per segment so every blob emitted by
// 'dataavailable' is a complete, self-contained WebM file (its own EBML
// header). Contrast with timeslice recording where only the first blob
// carries the header; subsequent blobs are raw continuation fragments that
// Whisper rejects with HTTP 400 "Invalid file format".
//
// The SAME stream + AudioContext are reused across segments — only the
// MediaRecorder instance is recreated.
// ---------------------------------------------------------------------------
function startSegment(stream, mimeType, generation) {
  if (!capturing || captureGeneration !== generation) return;

  const tabId    = activeTabId;  // closed-over; safe if activeTabId is nulled by stopCapture
  const recorder = new MediaRecorder(stream, { mimeType });
  mediaRecorder  = recorder;

  recorder.addEventListener("dataavailable", (event) => {
    if (!event.data || event.data.size === 0) return;
    blobToBase64(event.data).then((base64) => {
      api.runtime.sendMessage({
        type: "AUDIO_CHUNK",
        tabId,
        base64,
        mimeType: event.data.type || mimeType,
      }).catch(() => {
        // Background SW may have restarted — silently ignore
      });
    });
  });

  recorder.addEventListener("stop", () => {
    // Start the next segment only if this session is still active
    if (capturing && captureGeneration === generation) {
      startSegment(stream, mimeType, generation);
    }
    // When !capturing or generation mismatch: resource release happened
    // in stopCapture() — nothing to do here.
  });

  recorder.start(); // NO timeslice → one complete WebM blob per segment

  segmentTimer = setTimeout(() => {
    if (captureGeneration === generation && recorder.state !== "inactive") {
      try { recorder.stop(); } catch { /* ignore */ }
    }
  }, SEGMENT_MS);
}

// ---------------------------------------------------------------------------
// VU level loop
// Reads RMS from the AnalyserNode ~11 times/sec and broadcasts AUDIO_LEVEL.
// High-frequency-safe: fire-and-forget (.catch), never awaited.
// ---------------------------------------------------------------------------
function startVuLoop(sourceKind) {
  if (vuIntervalId !== null) {
    clearInterval(vuIntervalId);
    vuIntervalId = null;
  }

  const buf = new Uint8Array(analyser ? analyser.fftSize : 256);

  vuIntervalId = setInterval(() => {
    if (!capturing || !analyser) return;

    analyser.getByteTimeDomainData(buf);

    // RMS around 128 center (silence = 128, amplitude span = ±128)
    let sumSq = 0;
    for (let i = 0; i < buf.length; i++) {
      const v = (buf[i] - 128) / 128; // normalize to −1…+1
      sumSq += v * v;
    }
    const rms   = Math.sqrt(sumSq / buf.length);  // 0…1
    const level = Math.min(100, Math.round((rms / 0.5) * 100)); // 0.5 ≈ full-scale speech

    api.runtime.sendMessage({
      type: "AUDIO_LEVEL",
      tabId: activeTabId,
      level,
      sourceKind,
    }).catch(() => {
      // Side panel may not be open — ignore
    });
  }, 90);
}

// ---------------------------------------------------------------------------
// Stop capture — tears everything down; safe to call when not capturing
// ---------------------------------------------------------------------------
function stopCapture() {
  capturing = false;

  // Cancel the pending segment-end timer
  if (segmentTimer !== null) {
    clearTimeout(segmentTimer);
    segmentTimer = null;
  }

  // Stop the VU loop
  if (vuIntervalId !== null) {
    clearInterval(vuIntervalId);
    vuIntervalId = null;
  }

  // Stop the current segment recorder.
  // The 'stop' event will fire but captureGeneration check in startSegment
  // prevents it from spawning a new segment.
  if (mediaRecorder && mediaRecorder.state !== "inactive") {
    try { mediaRecorder.stop(); } catch { /* ignore */ }
  }
  mediaRecorder = null;

  // Release media stream tracks
  if (activeStream) {
    activeStream.getTracks().forEach((t) => t.stop());
    activeStream = null;
  }

  // Close AudioContext
  if (audioContext) {
    audioContext.close().catch(() => {});
    audioContext = null;
  }

  analyser    = null;
  activeTabId = null;
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
