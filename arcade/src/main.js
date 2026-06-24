// Arcade renderer stub — vanilla, no React, no framework.
// The full renderer is rewritten in a later phase. For now we just drop a
// placeholder into the existing #welcome container so the window shows
// something on launch.
(function () {
  function render() {
    var el = document.getElementById("welcome") || document.body;
    el.innerHTML =
      '<div style="text-align:center;opacity:.8;font-family:-apple-system,BlinkMacSystemFont,sans-serif">' +
      '<div style="font-size:22px;font-weight:600;margin-bottom:6px">Arcade</div>' +
      '<div style="opacity:.6">rebuild in progress</div>' +
      "</div>";
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", render);
  } else {
    render();
  }
})();
