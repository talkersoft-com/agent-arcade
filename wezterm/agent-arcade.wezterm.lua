-- Agent Arcade — WezTerm configuration (app-managed)
-- Docs: https://wezterm.org/config/files.html
--
-- This file is shipped INSIDE the app (repo: wezterm/, packaged: asar.unpacked)
-- and loaded only when WezTerm is launched by Agent Arcade — the app passes it via
-- `--config-file` and the WEZTERM_CONFIG_FILE env var. The user's own
-- ~/.wezterm.lua is never touched. Edit this file in the repo and ship it; do not
-- hand-edit the deployed copy.

local wezterm = require("wezterm")
local config = wezterm.config_builder()

-- WezTerm ships JetBrains Mono built-in and uses it by default, but we set it
-- explicitly here so it's obvious and easy to tweak.
config.font = wezterm.font("JetBrains Mono")
config.font_size = 13.0

-- A bit of breathing room and a sane default theme.
config.line_height = 1.1
config.color_scheme = "Tokyo Night"

local HOME = os.getenv("HOME") or ""

-- Read + parse a JSON sidecar written by the Agent Arcade apps. Returns nil on any
-- problem (missing file, bad JSON) so callers can fall back gracefully.
local function read_json(path)
  local ok, data = pcall(function()
    local f = io.open(path, "r")
    if not f then return nil end
    local c = f:read("*a")
    f:close()
    if not c or c == "" then return nil end
    return wezterm.json_parse(c)
  end)
  if ok then return data end
  return nil
end

-- ── Agent-colored tabs ────────────────────────────────────────────────────────
-- A GUI that *attaches* to the shared mux remaps pane ids and drops the OSC
-- user-vars an agent pane emitted before the attach — so neither the pane id nor
-- user-vars can identify an agent across the connect boundary. What DOES survive
-- is an explicit TAB TITLE (set via `wezterm cli set-tab-title`). So the spawner
-- sets each agent's tab title to its name and records name→color in
-- ~/.hv/wez-agents.json; we color the tab by matching its title.
local AGENTS_PATH = HOME .. "/.hv/wez-agents.json"

local function hex_rgb(hex)
  return tonumber(hex:sub(2, 3), 16) or 0,
    tonumber(hex:sub(4, 5), 16) or 0,
    tonumber(hex:sub(6, 7), 16) or 0
end

local function rgb_hex(r, g, b)
  local clamp = function(v) return math.max(0, math.min(255, math.floor(v + 0.5))) end
  return string.format("#%02x%02x%02x", clamp(r), clamp(g), clamp(b))
end

local function pick_fg(hex)
  -- choose black or white text based on the background's luminance
  local r, g, b = hex_rgb(hex)
  local lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255
  if lum > 0.6 then return "#000000" else return "#ffffff" end
end

-- Fade an agent color for an INACTIVE tab: pull it toward its own grey
-- (desaturate) and darken it. Hue is preserved, so the tab still reads as the
-- same agent — just clearly dimmed. desat/dark are 0..1.
local function fade(hex, desat, dark)
  local r, g, b = hex_rgb(hex)
  local grey = 0.299 * r + 0.587 * g + 0.114 * b
  r = r + (grey - r) * desat
  g = g + (grey - g) * desat
  b = b + (grey - b) * desat
  return rgb_hex(r * (1 - dark), g * (1 - dark), b * (1 - dark))
end

wezterm.on("format-tab-title", function(tab, _tabs, _panes, _config, _hover, max_width)
  local meta = read_json(AGENTS_PATH) or {}
  local name = tab.tab_title
  if name == nil or name == "" then name = tab.active_pane.title end
  local color = name and meta[name]
  if color and type(color) == "string" and color:match("^#%x%x%x%x%x%x$") then
    local label = " " .. name .. " "
    if #label > max_width then label = wezterm.truncate_right(label, max_width) end
    -- Active tab keeps the agent's full color; inactive tabs are faded but stay
    -- recognizably the same hue. This keys off WezTerm's own is_active, so it's
    -- correct whether the tab was switched from the app or clicked here directly.
    local bg = tab.is_active and color or fade(color, 0.55, 0.4)
    return {
      { Background = { Color = bg } },
      { Foreground = { Color = pick_fg(bg) } },
      { Text = label },
    }
  end
  -- non-agent tab: prefer the explicit title, else the pane's own title
  if tab.tab_title ~= nil and tab.tab_title ~= "" then return tab.tab_title end
  return tab.active_pane.title
end)

-- NOTE on pop-out window placement: a mux-connected window ignores BOTH
-- `--position` and Lua `window:set_position` (verified — the calls succeed but
-- the window never moves). The app therefore positions the pop-out via macOS
-- Accessibility (System Events) after it attaches; see arcade/main.js.

-- ── Shared multiplexer (hybrid headless / GUI) ────────────────────────────────
-- One persistent mux-server hosts every agent's Claude pane. The CLI drives it
-- HEADLESS (spawn / send-text / get-text) with no window; a GUI "watch" window
-- attaches to the SAME mux on demand (Arcade pop-out). Single source of truth —
-- no split-brain. Opening WezTerm normally also joins this one mux.
config.unix_domains = { { name = "unix" } }
config.default_domain = "unix"
config.default_gui_startup_args = { "connect", "unix" }

-- The Arcade owns the exit confirmation (warn-on-exit). Suppress WezTerm's own
-- "are you sure?" prompt so closing the watch window isn't a redundant double-ask —
-- closing the GUI only detaches the viewer anyway; the mux panes keep running.
config.window_close_confirmation = "NeverPrompt"

return config
