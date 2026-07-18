// The ONLY bridge to main: every read/write goes through window.tester.* (preload.js).
// Components never touch ipcRenderer; the store calls these.
export const tester = (typeof window !== "undefined" && window.tester) || {};

// Small helpers shared across screens (ported 1:1 from the reference renderer.js).
export const isUuid = (s) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(s || ""));

// Normalize "abc"/"#abc"/"aabbcc"/"#aabbcc" → "#aabbcc" (or "" if not a valid hex).
export function normHex(v) {
  v = (v || "").trim();
  if (/^#?[0-9a-fA-F]{6}$/.test(v)) return v[0] === "#" ? v.toLowerCase() : "#" + v.toLowerCase();
  if (/^#?[0-9a-fA-F]{3}$/.test(v)) {
    const h = v.replace("#", "");
    return "#" + h.split("").map((c) => c + c).join("").toLowerCase();
  }
  return "";
}

export const AGENT_PALETTE = [
  "#e6194B", "#3cb44b", "#4363d8", "#f58231", "#911eb4", "#42d4f4",
  "#f032e6", "#bfef45", "#469990", "#9A6324", "#800000", "#000075",
];
export function randomPaletteColor() {
  return AGENT_PALETTE[Math.floor(Math.random() * AGENT_PALETTE.length)];
}

// ── shortcut accelerator helpers (ported) ──
export const SC_SYM = { Command: "⌘", CommandOrControl: "⌘", Super: "⌘", Control: "⌃", Alt: "⌥", Shift: "⇧" };
export function accelToSymbols(a) { return a ? a.split("+").map((p) => SC_SYM[p] || p).join("") : ""; }
export function mainKeyFromEvent(e) {
  const c = e.code || "";
  let m;
  if ((m = /^Key([A-Z])$/.exec(c))) return m[1];
  if ((m = /^Digit([0-9])$/.exec(c))) return m[1];
  if ((m = /^Numpad([0-9])$/.exec(c))) return "num" + m[1];
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(c)) return c;
  const named = {
    Space: "Space", Enter: "Return", Tab: "Tab", Backspace: "Backspace", Delete: "Delete",
    ArrowUp: "Up", ArrowDown: "Down", ArrowLeft: "Left", ArrowRight: "Right", Home: "Home", End: "End",
    PageUp: "PageUp", PageDown: "PageDown", Minus: "-", Equal: "=", BracketLeft: "[", BracketRight: "]",
    Backslash: "\\", Semicolon: ";", Quote: "'", Comma: ",", Period: ".", Slash: "/", Backquote: "`",
  };
  return named[c] || null;
}
export function eventToAccel(e) {
  const mods = [];
  if (e.metaKey) mods.push("Command");
  if (e.ctrlKey) mods.push("Control");
  if (e.altKey) mods.push("Alt");
  if (e.shiftKey) mods.push("Shift");
  const key = mainKeyFromEvent(e);
  if (!key) return null;
  if (!mods.length) return { error: "modifier" };
  return { accel: [...mods, key].join("+") };
}

// Human-readable byte size: 612 MB / 2.4 GB. 0/absent → "".
export function fmtBytes(n) {
  n = Number(n) || 0;
  if (n <= 0) return "";
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0, v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  const s = v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1);
  return `${s} ${u[i]}`;
}
export function apiUrlIsLocal(url) {
  try { const h = new URL((url || "").trim()).hostname; return h === "localhost" || h === "127.0.0.1" || h === "::1"; }
  catch { return false; }
}

// ── mic capture → WAV (ported 1:1) ──
let audioCtx, source, processor, stream, chunks = [];
export async function startCapture(deviceId) {
  let label = "";
  if (deviceId === undefined) {                       // no explicit device → use the saved choice
    try { const a = await tester.getApp(); deviceId = (a && a.mic_device_id) || undefined; label = (a && a.mic_device_label) || ""; } catch {}
  }
  if (deviceId) {
    // exact id → label match (id goes stale after KVM/dock re-enumeration) → system default
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: { exact: deviceId } } }); } catch {
      stream = null;
      if (label) {
        try {
          const devs = await navigator.mediaDevices.enumerateDevices();
          const m = devs.find((d) => d.kind === "audioinput" && d.label === label);
          if (m) stream = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: { exact: m.deviceId } } });
        } catch {}
      }
    }
    if (!stream) stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } else {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  }
  // Persist which device Chromium ACTUALLY opened → Microphone row's "Last recording: X".
  try { const t = stream.getAudioTracks()[0]; if (t && t.label) tester.setApp({ mic_last_used: t.label }); } catch {}
  audioCtx = new AudioContext();
  source = audioCtx.createMediaStreamSource(stream);
  processor = audioCtx.createScriptProcessor(4096, 1, 1);
  chunks = [];
  processor.onaudioprocess = (e) => chunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
  source.connect(processor); processor.connect(audioCtx.destination);
}
export function stopCapture() {
  const rate = audioCtx.sampleRate;
  try { processor.disconnect(); source.disconnect(); } catch {}
  stream.getTracks().forEach((t) => t.stop());
  audioCtx.close();
  const len = chunks.reduce((a, c) => a + c.length, 0);
  const merged = new Float32Array(len);
  let off = 0; for (const c of chunks) { merged.set(c, off); off += c.length; }
  return { samples: merged, rate };
}
export function encodeWav(samples, rate) {
  const buf = new ArrayBuffer(44 + samples.length * 2), dv = new DataView(buf);
  const ws = (o, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
  ws(0, "RIFF"); dv.setUint32(4, 36 + samples.length * 2, true); ws(8, "WAVE");
  ws(12, "fmt "); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
  dv.setUint32(24, rate, true); dv.setUint32(28, rate * 2, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
  ws(36, "data"); dv.setUint32(40, samples.length * 2, true);
  let off = 44;
  for (let i = 0; i < samples.length; i++, off += 2) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    dv.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return buf;
}
