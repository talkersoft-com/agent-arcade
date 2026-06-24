// DOM access + tiny pure helpers shared across the render/keyboard layers.
// The Arcade reuses arcade/renderer/index.html verbatim, so these ids match the
// reference's markup exactly.
export const $ = (id) => document.getElementById(id);

// Built-in MacBook display has a camera notch (main passes ?notch=1) — pad top
// content below it (reference behavior).
export function applyNotch() {
  if (new URLSearchParams(location.search).get("notch") === "1") {
    document.body.classList.add("notch");
  }
}

export function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

export const PERSON = `<svg viewBox="0 0 24 24" fill="var(--c)"><path d="M12 12a5 5 0 1 0 0-10 5 5 0 0 0 0 10zm0 2c-5 0-9 2.6-9 6v2h18v-2c0-3.4-4-6-9-6z"/></svg>`;
export const personSvg = (c, n) => `<svg viewBox="0 0 24 24" width="${n}" height="${n}" fill="${c}"><path d="M12 12a5 5 0 1 0 0-10 5 5 0 0 0 0 10zm0 2c-5 0-9 2.6-9 6v2h18v-2c0-3.4-4-6-9-6z"/></svg>`;
