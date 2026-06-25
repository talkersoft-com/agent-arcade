// Sticky toast — the mitt-driven notification surface. Lives OUTSIDE the render
// cycle (subscribes to the bus, not a machine) so status redraws can't clobber it.
// Matches the reference toast()/hideToast() behavior + #toast markup.
import { $, esc } from "./dom.js";
import { bus } from "./bus.js";

let toastTimer = null;

export function wireToasts() {
  bus.on("toast", ({ text, kind } = {}) => show(text, kind));
  bus.on("toast:hide", hide);
  // Any key dismisses a sticky toast (still lets the key process elsewhere).
  document.addEventListener("keydown", (e) => {
    if (!e.repeat && $("toast") && $("toast").className) hide();
  });
}

function show(text, kind) {
  const el = $("toast"); if (!el) return;
  el.innerHTML = esc(text || "").replace(/\n/g, "<br>") + `<span class="dismiss">press any key to dismiss</span>`;
  el.className = "show" + (kind === "info" ? " info" : "");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hide, 30000);
}
function hide() { const el = $("toast"); if (el) el.className = ""; clearTimeout(toastTimer); }
