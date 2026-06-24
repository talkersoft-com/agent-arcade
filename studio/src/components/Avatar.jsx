import React from "react";
import { useStore } from "../store.js";

// A simple person silhouette, tinted with the agent's color (avatar placeholder).
export function AvatarGlyph({ color, size }) {
  const c = color || "#888888";
  const s = Math.round(size * 0.62);
  return (
    <span className="avatar" style={{ width: size, height: size, border: `2px solid ${c}`, background: `${c}22` }}>
      <svg viewBox="0 0 24 24" width={s} height={s} fill={c}>
        <path d="M12 12a5 5 0 1 0 0-10 5 5 0 0 0 0 10zm0 2c-5 0-9 2.6-9 6v2h18v-2c0-3.4-4-6-9-6z" />
      </svg>
    </span>
  );
}

// Avatar: the generated image when ready (served via aaimg://), otherwise the glyph.
// ?v=seed forces a refetch per-agent; &b=avatarBust forces a refetch after a regen.
export function Avatar({ agent, size }) {
  const avatarBust = useStore((s) => s.avatarBust);
  if (agent && agent.avatar_status === "ready") {
    const c = agent.color || "#888888";
    return (
      <span className="avatar" style={{ width: size, height: size, border: `2px solid ${c}`, padding: 0, overflow: "hidden" }}>
        <img
          src={`aaimg://a/${agent.id}?v=${agent.seed || 0}&b=${avatarBust}`}
          alt={`${agent.name || "agent"} avatar`}
          style={{ width: "100%", height: "100%", objectFit: "cover", borderRadius: "50%" }}
        />
      </span>
    );
  }
  return <AvatarGlyph color={agent && agent.color} size={size} />;
}
