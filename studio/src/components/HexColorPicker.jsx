import React, { useEffect, useRef } from "react";
import { normHex } from "../ipc.js";
import "../vendor/vanilla-colorful.js"; // defines <hex-color-picker>

// Thin React wrapper over the vanilla-colorful <hex-color-picker> web component.
// onChange fires with the picker's hex value as the user drags.
export function HexColorPicker({ value, onChange }) {
  const ref = useRef(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const handler = (e) => {
      const v = (e.detail && e.detail.value) || el.getAttribute("color") || "";
      onChange && onChange(v);
    };
    el.addEventListener("color-changed", handler);
    return () => el.removeEventListener("color-changed", handler);
  }, [onChange]);
  // Push the text value into the picker via attribute (survives lazy upgrade).
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const h = normHex(value);
    if (h && el.getAttribute("color") !== h) el.setAttribute("color", h);
  }, [value]);
  return React.createElement("hex-color-picker", { ref, id: "agent-color-picker" });
}
