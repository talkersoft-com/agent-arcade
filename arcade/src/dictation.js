// Dictation manager — the renderer-side owner of voice capture + the per-job actors.
//
// Responsibilities:
//   1. Mic CAPTURE (reference-style: getUserMedia → ScriptProcessor → mono 16-bit WAV).
//      Capture stays in the renderer (TCC lives here). Reused verbatim from the
//      reference's startCapture/stopCapture/encodeWav.
//   2. The dictation STATE MACHINE: ⌘D toggles idle→recording→pending; Go's events
//      (result/error) drive pending→confirmed|error. ONE job actor per job_id.
//   3. ASYNC-COMMIT anchor: the job actor + its originating agentId OUTLIVE navigation.
//      A Go verdict that arrives after the user navigated away is applied to the
//      ORIGINATING agent (status + toast name THAT agent), never the now-current one.
//
// What this manager does NOT do: it does not send cleaned text into the pane. main's
// handleGo → routeToAgent already routes the cleaned text to the originating agent
// (keyed by job_id), and that path is retained (docs/IPC.md §3c, §7.1). So the machine
// here OBSERVES Go's events to drive UI/per-agent status; main owns the actual delivery.
import { createActor } from "xstate";
import { dictationMachine } from "./machines/dictationActor.js";
import { bus } from "./bus.js";

const arcade = (typeof window !== "undefined" && window.arcade) || {};

// ── capability gate (mirrors the reference's dictationAvailable) ──
let dictationAvailable = false;
export function isDictationAvailable() { return dictationAvailable; }

// ── recordingNavBehavior: "send" (default) | "lock". Read from arcade app settings. ──
let recordingNavBehavior = "send";
export function recordingNav() { return recordingNavBehavior; }

// ── live recording state (single concurrent recording, as in the reference) ──
// We track the ONE in-progress capture; once committed, its job actor lives on its own
// in `jobs` until Go resolves it. recAgentId/recAgentName name the originating agent.
let recording = false;
let recAgentId = null;
let recAgentName = "";
let recJobId = null;          // the job actor id while still recording (pre-commit)
let committing = false;       // guard: a 2nd ⌘D during the tail drain must not re-enter

// job_id -> { actor, agentId, agentName }. Keyed by job_id so a late Go event resolves
// back to the right (originating) actor.
const jobs = new Map();

let nextJob = 1;
function newJobId() { return "arc-" + (nextJob++) + "-" + Date.now().toString(36); }

// app-settings timing (read live from arcade settings; reference defaults).
let dictTailMs = 250;
let dictPadMs = 200;

// `host` is supplied by main.js — the bridge to the root machine / focused agent:
//   { focusedAgent(), isRecordingAgent(id), setAgentStatus(agentId, status), agentName(id) }
let host = null;
export function setDictationHost(h) { host = h; }

// ── public API for the keyboard layer ──
export function isRecording() { return recording; }
export function recordingAgentId() { return recAgentId; }

// ⌘D toggle: idle→recording, or recording→commit (build WAV + dispatch → pending).
export async function toggleDictation() {
  if (!dictationAvailable) return;
  if (recording) return commitDictation();
  return startDictation();
}

// Esc while recording → cancel + DISCARD (no dispatch). The ONLY discard path.
export function cancelDictation() {
  if (!recording) return;
  const actor = recJobId ? jobs.get(recJobId) : null;
  recording = false;
  stopCaptureSafe();
  if (actor) { actor.actor.send({ type: "CANCEL" }); jobs.delete(recJobId); }
  const name = recAgentName;
  const aid = recAgentId;
  clearRecState();
  if (host && aid) host.setAgentStatus(aid, "idle");
  bus.emit("dictation:state", { recording: false, agentId: aid });
  bus.emit("toast", { text: "Recording cancelled", kind: "info" });
  return name;
}

// Commit-then-navigate (recordingNavBehavior:"send"): dispatch the job for the ORIGINAL
// agent and return immediately so navigation can proceed. The job actor outlives the nav.
// Returns the originating agent name for the caller's "Sent to […]" toast.
export async function commitForNavigation() {
  if (!recording) return null;
  const name = recAgentName;
  await commitDictation();
  return name;
}

// ── start: capture FIRST (reference order so opening words aren't clipped) ──
async function startDictation() {
  const a = host && host.focusedAgent();
  if (!a) return;
  if (!a.running) { bus.emit("toast", { text: "Agent not running — launch it first.", kind: "error" }); return; }
  try { await startCapture(); }
  catch (e) { bus.emit("toast", { text: "Mic error: " + (e && e.message), kind: "error" }); return; }
  recording = true;
  recAgentId = a.id;
  recAgentName = a.name || "(unnamed)";
  recJobId = newJobId();
  committing = false;
  // Spawn the job actor (born recording). Bound to the ORIGINATING agent for its life.
  const actor = createActor(dictationMachine, {
    id: "dict-" + recJobId,
    input: { jobId: recJobId, agentId: recAgentId, agentName: recAgentName },
  });
  actor.start();
  jobs.set(recJobId, { actor, agentId: recAgentId, agentName: recAgentName });
  if (host) host.setAgentStatus(recAgentId, "recording");
  bus.emit("dictation:state", { recording: true, agentId: recAgentId });
}

// ── commit: drain tail, build padded WAV, dispatch via window.arcade.dictate → pending ──
async function commitDictation() {
  if (committing) return;        // a 2nd ⌘D during the drain must not re-enter
  committing = true;
  const jobId = recJobId;
  const job = jobId ? jobs.get(jobId) : null;
  const agentId = recAgentId;
  recording = false;
  bus.emit("dictation:state", { recording: false, agentId });
  // Keep capturing for a short tail so the final word isn't clipped (4096-sample chunks
  // are still in flight when you hit send).
  await new Promise((r) => setTimeout(r, dictTailMs));
  const { samples, rate } = stopCaptureSafe();
  clearRecState();
  if (!samples || !samples.length) {
    if (job) { job.actor.send({ type: "FAIL", error: "no audio captured" }); jobs.delete(jobId); }
    bus.emit("toast", { text: "No audio captured", kind: "error" });
    committing = false;
    return;
  }
  // Reflect "sending" on the ORIGINATING agent immediately.
  if (host) host.setAgentStatus(agentId, "sending");
  // Pad trailing silence so the ASR sees a clean end-of-utterance.
  const pad = Math.floor((dictPadMs / 1000) * (rate || 48000));
  const padded = new Float32Array(samples.length + pad);
  padded.set(samples, 0);
  const wav = encodeWav(padded, rate);
  // Move the actor to `pending` BEFORE the dispatch resolves — Go's event may already be
  // arriving. The dispatch only confirms main accepted the WAV; success comes from Go.
  if (job) job.actor.send({ type: "COMMIT" });
  committing = false;
  try {
    const res = await arcade.dictate(agentId, wav);
    if (res && res.ok === false) {
      // main refused the WAV → never reached Go. Error against the originating agent.
      if (job) { job.actor.send({ type: "GO_ERROR", error: res.error || "dispatch failed" }); jobs.delete(jobId); }
      if (host) host.setAgentStatus(agentId, "error");
      bus.emit("toast", { text: "Dictation failed: " + (res.error || "dispatch failed"), kind: "error" });
    }
    // res.ok === true → do NOT confirm here. Confirmation is Go's RESULT event (never
    // assume success on dispatch — docs/IPC.md §0).
  } catch (e) {
    if (job) { job.actor.send({ type: "GO_ERROR", error: (e && e.message) || "dispatch failed" }); jobs.delete(jobId); }
    if (host) host.setAgentStatus(agentId, "error");
    bus.emit("toast", { text: "Dictation failed: " + (e && e.message), kind: "error" });
  }
}

// ── THE one translate site for Go's dictation stream → job-actor events ──
// Called by ipc.js with the raw NDJSON object (annotated with agentId). This is where a
// late Go verdict is bound back to the ORIGINATING agent via job_id.
export function onGoEvent(p) {
  if (!p || !p.job_id) return;          // ready/health_result/log carry no job_id
  const job = jobs.get(p.job_id);
  if (!job) return;                     // not ours (e.g. a Studio job) — ignore
  if (p.type === "result") {
    job.actor.send({ type: "RESULT", cleaned_text: p.cleaned_text });
    // main's routeToAgent delivers the text into job.agentId's pane; we reflect status
    // + toast against the ORIGINATING agent (NOT whichever agent is current now).
    if (host) host.setAgentStatus(job.agentId, "delivered");
    jobs.delete(p.job_id);
  } else if (p.type === "error") {
    job.actor.send({ type: "GO_ERROR", error: p.error });
    if (host) host.setAgentStatus(job.agentId, "error");
    bus.emit("toast", { text: (job.agentName ? job.agentName + ": " : "") + "dictation failed: " + (p.error || ""), kind: "error" });
    jobs.delete(p.job_id);
  }
  // status/ready/health_result: observable, no transition.
}

// Availability + timing pushes (from the IPC seam onDictation + settings load).
export function setDictationAvailable(s) {
  dictationAvailable = !!(s && s.available);
  if (recording && !dictationAvailable) cancelDictation(); // backend vanished mid-recording
}
export function applyDictationSettings(app) {
  if (!app) return;
  if (Number.isFinite(app.dictation_tail_ms)) dictTailMs = app.dictation_tail_ms;
  if (Number.isFinite(app.dictation_pad_ms)) dictPadMs = app.dictation_pad_ms;
  if (typeof app.mic_device_id === "string") micDeviceId = app.mic_device_id;
  if (typeof app.mic_device_label === "string") micDeviceLabel = app.mic_device_label;
  if (app.recordingNavBehavior === "lock" || app.recordingNavBehavior === "send") {
    recordingNavBehavior = app.recordingNavBehavior;
  }
}

function clearRecState() { recAgentId = null; recAgentName = ""; recJobId = null; }

// ── capture (Web Audio → mono 16-bit WAV) — reused from the reference verbatim ──
let audioCtx, source, processor, stream, chunks = [];
let lastRate = 48000;
let micDeviceId = "";     // chosen input device (app.mic_device_id); "" = system default
let micDeviceLabel = "";  // its label — fallback match when the id goes stale (KVM/dock re-enumeration)
// Open the chosen mic: exact id → label match → system default (with a toast so a silent
// fallback can't masquerade as the chosen device).
async function openMicStream() {
  if (micDeviceId) {
    try { return await navigator.mediaDevices.getUserMedia({ audio: { deviceId: { exact: micDeviceId } } }); } catch {}
    if (micDeviceLabel) {
      try {
        const devs = await navigator.mediaDevices.enumerateDevices();
        const m = devs.find((d) => d.kind === "audioinput" && d.label === micDeviceLabel);
        if (m) return await navigator.mediaDevices.getUserMedia({ audio: { deviceId: { exact: m.deviceId } } });
      } catch {}
    }
    bus.emit("toast", { text: "Saved microphone not found — using system default", kind: "info" });
  }
  return navigator.mediaDevices.getUserMedia({ audio: true });
}
async function startCapture() {
  stream = await openMicStream();
  // Report the device Chromium ACTUALLY opened (track.label is ground truth) so
  // Studio's Microphone row can show a verifiable "Last recording: X".
  try { const t = stream.getAudioTracks()[0]; if (t && t.label && arcade.micUsed) arcade.micUsed(t.label); } catch {}
  audioCtx = new AudioContext();
  source = audioCtx.createMediaStreamSource(stream);
  processor = audioCtx.createScriptProcessor(4096, 1, 1);
  chunks = [];
  processor.onaudioprocess = (e) => chunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
  source.connect(processor); processor.connect(audioCtx.destination);
}
function stopCapture() {
  const rate = audioCtx.sampleRate;
  try { processor.disconnect(); source.disconnect(); } catch {}
  try { stream.getTracks().forEach((t) => t.stop()); } catch {}
  try { audioCtx.close(); } catch {}
  const len = chunks.reduce((a, c) => a + c.length, 0);
  const merged = new Float32Array(len); let off = 0;
  for (const c of chunks) { merged.set(c, off); off += c.length; }
  return { samples: merged, rate };
}
function stopCaptureSafe() {
  try { const r = stopCapture(); lastRate = r.rate || lastRate; return r; }
  catch { return { samples: new Float32Array(0), rate: lastRate }; }
}
function encodeWav(samples, rate) {
  const buf = new ArrayBuffer(44 + samples.length * 2), dv = new DataView(buf);
  const ws = (o, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
  ws(0, "RIFF"); dv.setUint32(4, 36 + samples.length * 2, true); ws(8, "WAVE");
  ws(12, "fmt "); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
  dv.setUint32(24, rate, true); dv.setUint32(28, rate * 2, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
  ws(36, "data"); dv.setUint32(40, samples.length * 2, true);
  let off = 44;
  for (let i = 0; i < samples.length; i++, off += 2) { const s = Math.max(-1, Math.min(1, samples[i])); dv.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true); }
  return buf;
}
