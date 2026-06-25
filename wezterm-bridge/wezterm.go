// Package main: a thin Go driver over `wezterm cli`.
//
// This is the "last leg" of the dictation loop: cleaned text -> a WezTerm pane.
// It shells out to `wezterm cli` only — no fork, no Lua, no source changes.
package main

import (
	"bytes"
	"fmt"
	"os/exec"
	"strconv"
	"strings"
)

// wez wraps the `wezterm` binary. The path is configurable so this works whether
// wezterm is on PATH or only at the Homebrew location.
type wez struct {
	bin string
}

func newWez(bin string) *wez {
	if bin == "" {
		bin = "wezterm"
	}
	return &wez{bin: bin}
}

// run invokes `wezterm cli <args...>`, optionally feeding stdin, and returns
// trimmed stdout. On failure it returns an error that includes stderr so callers
// (and the user) get a clear message instead of a crash.
func (w *wez) run(stdin string, args ...string) (string, error) {
	full := append([]string{"cli"}, args...)
	cmd := exec.Command(w.bin, full...)
	if stdin != "" {
		cmd.Stdin = strings.NewReader(stdin)
	}
	var out, errb bytes.Buffer
	cmd.Stdout = &out
	cmd.Stderr = &errb
	if err := cmd.Run(); err != nil {
		msg := strings.TrimSpace(errb.String())
		if msg == "" {
			msg = err.Error()
		}
		return "", fmt.Errorf("wezterm cli %s: %s", strings.Join(args, " "), msg)
	}
	return strings.TrimSpace(out.String()), nil
}

// Spawn starts prog in a new tab (or new window) and returns the new pane id.
func (w *wez) Spawn(newWindow bool, prog ...string) (int, error) {
	args := []string{"spawn"}
	if newWindow {
		args = append(args, "--new-window")
	} else if ref := w.refPane(); ref != "" {
		// Anchor the spawn to an existing pane so wezterm knows which window/domain
		// to use. Without this it relies on the *focused* GUI pane, which fails
		// ("couldn't determine which pane was currently focused") when WezTerm
		// isn't the frontmost app — e.g. when spawning from the Electron app.
		args = append(args, "--pane-id", ref)
	}
	if len(prog) > 0 {
		args = append(args, "--")
		args = append(args, prog...)
	}
	out, err := w.run("", args...)
	if err != nil {
		return 0, err
	}
	id, err := strconv.Atoi(strings.TrimSpace(out))
	if err != nil {
		return 0, fmt.Errorf("spawn returned non-numeric pane id %q: %w", out, err)
	}
	return id, nil
}

// refPane returns the id of any existing pane (the first listed), to anchor a
// spawn's window/domain. Empty if none / unreachable.
func (w *wez) refPane() string {
	out, err := w.run("", "list")
	if err != nil {
		return ""
	}
	for _, line := range strings.Split(out, "\n") {
		f := strings.Fields(line)
		if len(f) >= 3 {
			if _, e := strconv.Atoi(f[2]); e == nil {
				return f[2]
			}
		}
	}
	return ""
}

// spawnCwd is Spawn into a new tab with an explicit working directory.
func (w *wez) spawnCwd(cwd string, prog ...string) (int, error) {
	args := []string{"spawn", "--cwd", cwd}
	if ref := w.refPane(); ref != "" {
		args = append(args, "--pane-id", ref) // anchor to an existing pane (see Spawn)
	} else {
		// Empty mux (e.g. a fresh headless mux-server, no GUI/panes yet): there's no
		// focused pane to anchor to, so we must explicitly open the first window.
		args = append(args, "--new-window")
	}
	if len(prog) > 0 {
		args = append(args, "--")
		args = append(args, prog...)
	}
	out, err := w.run("", args...)
	if err != nil {
		return 0, err
	}
	id, err := strconv.Atoi(strings.TrimSpace(out))
	if err != nil {
		return 0, fmt.Errorf("spawn returned non-numeric pane id %q: %w", out, err)
	}
	return id, nil
}

// SendText types text into the pane. With paste=true it goes via bracketed paste
// (the pane sees one atomic paste); with paste=false the bytes are sent raw.
// It does NOT submit — call Enter for that.
func (w *wez) SendText(paneID int, text string, paste bool) error {
	args := []string{"send-text", "--pane-id", strconv.Itoa(paneID)}
	if !paste {
		args = append(args, "--no-paste")
	}
	// Pass the text on stdin so newlines/quotes/special chars are never mangled
	// by the shell or argv.
	_, err := w.run(text, args...)
	return err
}

// Enter sends a single carriage return as its own, raw send-text. This is the
// submit. Keeping it separate from SendText is what makes TUIs like Claude treat
// it as "submit" rather than "insert a newline into the prompt box".
func (w *wez) Enter(paneID int) error {
	_, err := w.run("\r", "send-text", "--pane-id", strconv.Itoa(paneID), "--no-paste")
	return err
}

// Activate brings the pane to the foreground / focus.
func (w *wez) Activate(paneID int) error {
	_, err := w.run("", "activate-pane", "--pane-id", strconv.Itoa(paneID))
	return err
}

// SetTabTitle sets an explicit title on the tab that owns paneID. Unlike the pane
// title (which the running program, e.g. claude, overwrites) and OSC user-vars
// (which don't survive a GUI attaching to the shared mux), an explicit tab title
// DOES propagate to a connected GUI — so wezterm.lua can color the tab by it.
func (w *wez) SetTabTitle(paneID int, title string) error {
	_, err := w.run("", "set-tab-title", "--pane-id", strconv.Itoa(paneID), title)
	return err
}

// GetText captures the current textual content of the pane (the visible screen).
func (w *wez) GetText(paneID int) (string, error) {
	return w.run("", "get-text", "--pane-id", strconv.Itoa(paneID))
}

// GetTextEscapes includes ANSI escape sequences (colors/attributes) in the output.
func (w *wez) GetTextEscapes(paneID int) (string, error) {
	return w.run("", "get-text", "--pane-id", strconv.Itoa(paneID), "--escapes")
}

// List returns the raw `wezterm cli list` table — used during setup to find a
// pane id by eye.
func (w *wez) List() (string, error) {
	return w.run("", "list")
}

// PaneExists reports whether paneID appears in `wezterm cli list`, so a bad id
// gives a clear error instead of a confusing downstream failure.
func (w *wez) PaneExists(paneID int) (bool, error) {
	out, err := w.List()
	if err != nil {
		return false, err
	}
	target := strconv.Itoa(paneID)
	for _, line := range strings.Split(out, "\n") {
		for _, f := range strings.Fields(line) {
			if f == target {
				return true, nil
			}
		}
	}
	return false, nil
}
