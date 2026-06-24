import React from "react";
import { createRoot } from "react-dom/client";

function App() {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        height: "100vh",
        margin: 0,
        fontFamily:
          "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
        background: "#0b0b10",
        color: "#e7e7ee",
      }}
    >
      <h1 style={{ fontWeight: 600, fontSize: 22 }}>Agent Arcade Studio</h1>
      <p style={{ opacity: 0.6 }}>rebuild in progress</p>
    </div>
  );
}

const el = document.getElementById("root");
createRoot(el).render(<App />);
