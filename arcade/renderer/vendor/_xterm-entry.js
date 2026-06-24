// One-time bundle source for the Arcade workspace shell (vendored → xterm.js).
// Rebuild: npx esbuild arcade/renderer/vendor/_xterm-entry.js --bundle --format=iife --global-name=AAXterm --minify --outfile=arcade/renderer/vendor/xterm.js
export { Terminal } from "@xterm/xterm";
export { FitAddon } from "@xterm/addon-fit";
