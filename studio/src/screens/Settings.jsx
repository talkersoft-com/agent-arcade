import React, { useEffect, useState } from "react";
import { useStore } from "../store.js";
import { SettingsGeneral } from "./SettingsGeneral.jsx";
import { SettingsBackend } from "./SettingsBackend.jsx";
import { SettingsDisplays } from "./SettingsDisplays.jsx";
import { SettingsOrg } from "./SettingsOrg.jsx";

const TABS = [
  { id: "general", label: "General" },
  { id: "backend", label: "Dictation" },
  { id: "displays", label: "Displays" },
  { id: "filters", label: "Organization" },
];

export function Settings() {
  const [stab, setStab] = useState("general");
  const loadSettings = useStore((s) => s.loadSettings);
  const loadOrg = useStore((s) => s.loadOrg);
  const loadBackend = useStore((s) => s.loadBackend);

  // General loads app settings + shortcuts + displays on mount.
  useEffect(() => { loadSettings(); }, []);

  // Per-tab loaders (mirror the reference sub-tab click handlers).
  useEffect(() => {
    if (stab === "filters") loadOrg();
    if (stab === "backend") loadBackend();
    if (stab === "displays") loadSettings();
  }, [stab]);

  return (
    <div className="view active" id="view-settings">
      <div className="tabs" id="settings-tabs">
        {TABS.map((t) => (
          <button key={t.id} className={"tab" + (stab === t.id ? " active" : "")} onClick={() => setStab(t.id)}>{t.label}</button>
        ))}
      </div>
      {stab === "general" && <SettingsGeneral />}
      {stab === "backend" && <SettingsBackend />}
      {stab === "displays" && <SettingsDisplays />}
      {stab === "filters" && <SettingsOrg />}
    </div>
  );
}
