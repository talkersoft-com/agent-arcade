import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import studioCss from "./studio.css";
import { tester } from "./ipc.js";

// Inject the reference's stylesheet (imported as text via the esbuild `.css` loader)
// so the SPA looks 1:1 without a separate <link> in renderer/index.html.
(() => {
  const tag = document.createElement("style");
  tag.textContent = studioCss;
  document.head.appendChild(tag);
})();
import { useStore, wireIpc } from "./store.js";
import { Agents } from "./screens/Agents.jsx";
import { Settings } from "./screens/Settings.jsx";
import { Tour } from "./screens/Tour.jsx";

// Dev build (main passes ?dev=1): cyan Home Saturn + "(Dev)" title tag.
if (new URLSearchParams(location.search).get("dev") === "1") document.body.classList.add("dev");

function App() {
  const view = useStore((s) => s.view);
  const agents = useStore((s) => s.agents);
  const refreshAgents = useStore((s) => s.refreshAgents);
  const setDictation = useStore((s) => s.setDictation);
  const activateView = useStore((s) => s.activateView);
  const [booted, setBooted] = useState(false);
  const [tour, setTour] = useState(false);

  useEffect(() => {
    wireIpc();
    // Menu-bar routes for a running window.
    tester.onOpenPreferences && tester.onOpenPreferences(() => activateView("settings"));
    tester.onOpenStudio && tester.onOpenStudio(() => { activateView("agents"); refreshAgents(); });

    (async () => {
      // Seed the dictation gate from main's cached probe BEFORE first render so a
      // missing backend never flashes a dictate button / Dictation tab.
      try { setDictation(await tester.dictationGet()); } catch {}
      await refreshAgents();
      const wantPrefs = new URLSearchParams(location.search).get("view") === "settings";
      if (wantPrefs) { activateView("settings"); setBooted(true); return; }
      activateView("agents");
      const list = useStore.getState().agents;
      if (list.length === 0) setTour(true); // first-run guided wizard
      setBooted(true);
    })();
  }, []);

  // body.tour-active disables nav escape (parity with the reference).
  useEffect(() => { document.body.classList.toggle("tour-active", tour); }, [tour]);

  if (!booted) return null;
  if (tour) return <Tour onDone={() => setTour(false)} />;
  return view === "settings" ? <Settings /> : <Agents />;
}

const el = document.getElementById("root");
createRoot(el).render(<App />);
