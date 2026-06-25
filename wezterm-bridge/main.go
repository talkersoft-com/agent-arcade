// wezterm-bridge — the dictation loop's last leg:
// deliver text into a WezTerm pane (and optionally read back what it produced),
// driving WezTerm entirely through `wezterm cli`.
//
// Subcommands:
//
//	list                         # show panes + ids (for setup)
//	send   -text "..."           # send text to a pane, submit with Enter
//	send   -file path            # ...from a file (the dictation use-case)
//	demo-echo                    # SAFE proof: spawn a shell, echo, capture back
//	demo-claude -file prompt.txt # spawn claude, wait, send a prompt, capture
//
// Pane targeting / focus follow the alpha brief:
//
//	WEZTERM_PANE_ID  target pane id (overridden by -pane)
//	WEZTERM_RAISE    "1"/"true" to focus the pane after sending (or -raise)
//	WEZTERM_BIN      path to the wezterm binary (default: "wezterm" on PATH)
package main

import (
	"encoding/base64"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

func main() {
	if len(os.Args) < 2 {
		usage()
		os.Exit(2)
	}
	w := newWez(getenv("WEZTERM_BIN", "wezterm"))
	cmd, args := os.Args[1], os.Args[2:]

	var err error
	switch cmd {
	case "list":
		err = cmdList(w)
	case "spawn":
		err = cmdSpawn(w, args)
	case "activate":
		err = cmdActivate(w, args)
	case "esc":
		err = cmdEsc(w, args)
	case "kill":
		err = cmdKill(w, args)
	case "pane-ids":
		err = cmdPaneIds(w)
	case "get-text":
		err = cmdGetText(w, args)
	case "send":
		err = cmdSend(w, args)
	case "demo-echo":
		err = cmdDemoEcho(w, args)
	case "demo-claude":
		err = cmdDemoClaude(w, args)
	case "-h", "--help", "help":
		usage()
		return
	default:
		fmt.Fprintf(os.Stderr, "unknown subcommand %q\n\n", cmd)
		usage()
		os.Exit(2)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		os.Exit(1)
	}
}

func usage() {
	fmt.Fprint(os.Stderr, `wezterm-bridge — push text into a WezTerm pane via `+"`wezterm cli`"+`

  wezterm-bridge list
  wezterm-bridge spawn [-claude] [-cwd dir] [-new-window]   # prints the new pane id
  wezterm-bridge send [-pane N] [-text "..."] [-file path] [-raise] [-no-submit] [-capture]
  wezterm-bridge demo-echo [-pane N]          # safe end-to-end proof (no Claude)
  wezterm-bridge demo-claude [-text ..|-file ..] [-pane N] [-boot 60s] [-settle 8s]

env: WEZTERM_PANE_ID, WEZTERM_RAISE, WEZTERM_BIN
`)
}

func cmdList(w *wez) error {
	out, err := w.List()
	if err != nil {
		return err
	}
	fmt.Println(out)
	return nil
}

// cmdSpawn opens a new pane (a shell, or claude with -claude) and prints ONLY
// the new pane id on stdout — so a caller can capture it as the target pane.
func cmdSpawn(w *wez, args []string) error {
	fs := flag.NewFlagSet("spawn", flag.ExitOnError)
	claude := fs.Bool("claude", false, "spawn `claude` instead of a shell")
	bin := fs.String("bin", "claude", "the claude command to run (with -claude)")
	cwd := fs.String("cwd", "", "working directory for the new pane")
	tabcolor := fs.String("tabcolor", "", "color this pane's tab via a WezTerm user var (#rrggbb)")
	aname := fs.String("name", "", "agent name to show on the tab (WezTerm user var)")
	newWindow := fs.Bool("new-window", false, "spawn into a new window instead of a tab")
	_ = fs.Parse(args)

	// Any args after `--` are passed through to the program, e.g.
	//   spawn -claude -cwd DIR -- --session-id UUID
	//   spawn -claude -cwd DIR -- --resume UUID
	extra := fs.Args()
	var prog []string
	if *claude {
		// Strip Claude Code's own session env so the spawned claude runs as a
		// fresh top-level session. If these are inherited (e.g. the app/WezTerm
		// was launched from inside a Claude Code session), claude treats itself
		// as a nested child and won't persist its session for --resume.
		// `env -u` on an unset var is harmless, so this is always safe.
		base := append([]string{"env",
			"-u", "CLAUDECODE",
			"-u", "CLAUDE_CODE_SESSION_ID",
			"-u", "CLAUDE_CODE_CHILD_SESSION",
			"-u", "CLAUDE_CODE_ENTRYPOINT",
			"-u", "CLAUDE_CODE_EXECPATH",
			*bin,
		}, extra...)
		if *tabcolor != "" || *aname != "" {
			// Emit OSC 1337 SetUserVar (agent_color / agent_name) so wezterm.lua can
			// color this tab, then exec claude. Base64 values are printf-safe.
			var sb strings.Builder
			if *tabcolor != "" {
				sb.WriteString("printf '\\033]1337;SetUserVar=agent_color=" + b64(*tabcolor) + "\\007'; ")
			}
			if *aname != "" {
				sb.WriteString("printf '\\033]1337;SetUserVar=agent_name=" + b64(*aname) + "\\007'; ")
			}
			sb.WriteString("exec " + strings.Join(base, " "))
			prog = []string{"bash", "-lc", sb.String()}
		} else {
			prog = base
		}
	} else if len(extra) > 0 {
		prog = extra
	}
	var (
		pane int
		err  error
	)
	if *cwd != "" {
		pane, err = w.spawnCwd(*cwd, prog...)
	} else {
		pane, err = w.Spawn(*newWindow, prog...)
	}
	if err != nil {
		return fmt.Errorf("spawn (is the WezTerm GUI running?): %w", err)
	}

	// Color the tab. A mux-connected GUI remaps pane ids and drops OSC user-vars,
	// so neither survives the connect boundary. What DOES survive is an explicit
	// tab title — so we (a) set the tab title to the agent name, and (b) record
	// name→color in ~/.hv/wez-agents.json. wezterm.lua then colors the tab by its
	// title. Both need a name; color without a name can't be matched.
	if *aname != "" {
		if e := w.SetTabTitle(pane, *aname); e != nil {
			fmt.Fprintln(os.Stderr, "warn: set-tab-title:", e)
		}
		if *tabcolor != "" {
			if e := writeAgentMeta(*aname, *tabcolor); e != nil {
				fmt.Fprintln(os.Stderr, "warn: tab color sidecar:", e)
			}
		}
	}

	fmt.Println(pane) // stdout = just the id, for easy capture
	return nil
}

// writeAgentMeta merges {name: color} into ~/.hv/wez-agents.json. Keyed by agent
// name (the tab title), which is stable across mux restarts and the GUI connect
// boundary — no pane-id pruning needed.
func writeAgentMeta(name, color string) error {
	dir := filepath.Join(getenv("HOME", ""), ".hv")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	path := filepath.Join(dir, "wez-agents.json")

	m := map[string]string{}
	if b, err := os.ReadFile(path); err == nil {
		_ = json.Unmarshal(b, &m) // best-effort; a corrupt file is just replaced
	}
	m[name] = color
	b, err := json.MarshalIndent(m, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, b, 0o644)
}

// cmdActivate focuses a pane.
func cmdActivate(w *wez, args []string) error {
	fs := flag.NewFlagSet("activate", flag.ExitOnError)
	pane := fs.Int("pane", 0, "pane id to focus")
	_ = fs.Parse(args)
	if *pane == 0 {
		return fmt.Errorf("activate: -pane required")
	}
	return w.Activate(*pane)
}

// cmdEsc sends a single Escape key to a pane (dismiss a menu/prompt on demand).
func cmdEsc(w *wez, args []string) error {
	fs := flag.NewFlagSet("esc", flag.ExitOnError)
	pane := fs.Int("pane", 0, "pane id to send Esc to")
	_ = fs.Parse(args)
	if *pane == 0 {
		return fmt.Errorf("esc: -pane required")
	}
	_, err := w.run("\x1b", "send-text", "--pane-id", strconv.Itoa(*pane), "--no-paste")
	return err
}

// cmdKill kills a pane (terminating the process running in it, e.g. claude).
func cmdKill(w *wez, args []string) error {
	fs := flag.NewFlagSet("kill", flag.ExitOnError)
	pane := fs.Int("pane", 0, "pane id to kill")
	_ = fs.Parse(args)
	if *pane == 0 {
		return fmt.Errorf("kill: -pane required")
	}
	// Missing pane → treat as already-gone (idempotent), not an error.
	if ok, err := w.PaneExists(*pane); err == nil && !ok {
		return nil
	}
	_, err := w.run("", "kill-pane", "--pane-id", strconv.Itoa(*pane))
	return err
}

// cmdGetText prints the textual content of a pane (its visible screen).
func cmdGetText(w *wez, args []string) error {
	fs := flag.NewFlagSet("get-text", flag.ExitOnError)
	pane := fs.Int("pane", 0, "pane id to read")
	escapes := fs.Bool("escapes", false, "include ANSI escape sequences (colors/attributes)")
	_ = fs.Parse(args)
	if *pane == 0 {
		return fmt.Errorf("get-text: -pane required")
	}
	var out string
	var err error
	if *escapes {
		out, err = w.GetTextEscapes(*pane)
	} else {
		out, err = w.GetText(*pane)
	}
	if err != nil {
		return err
	}
	fmt.Println(out)
	return nil
}

// cmdPaneIds prints the id of every live pane, one per line (for liveness checks).
func cmdPaneIds(w *wez) error {
	out, err := w.List()
	if err != nil {
		return err
	}
	for _, line := range strings.Split(out, "\n") {
		f := strings.Fields(line)
		if len(f) >= 3 {
			if _, e := strconv.Atoi(f[2]); e == nil { // col 3 = PANEID; header row skipped
				fmt.Println(f[2])
			}
		}
	}
	return nil
}

// cmdSend is the core dictation operation: text (inline or from a file) -> pane.
func cmdSend(w *wez, args []string) error {
	fs := flag.NewFlagSet("send", flag.ExitOnError)
	pane := fs.Int("pane", envInt("WEZTERM_PANE_ID", 0), "target pane id")
	text := fs.String("text", "", "text to send")
	file := fs.String("file", "", "file whose contents to send")
	raise := fs.Bool("raise", envBool("WEZTERM_RAISE"), "focus the pane after sending")
	noSubmit := fs.Bool("no-submit", false, "do not press Enter after the text")
	capture := fs.Bool("capture", false, "after sending, print pane contents")
	paste := fs.Bool("paste", true, "send as a bracketed paste (false = raw keystrokes)")
	esc := fs.Bool("esc", false, "send one Esc (then settle) before the text — backs out of Claude menus/prompts")
	escDelay := fs.Int("esc-delay", 50, "ms to wait after Esc before sending the text")
	_ = fs.Parse(args)

	if *pane == 0 {
		return fmt.Errorf("no pane id: pass -pane N or set WEZTERM_PANE_ID (use `list` to find one)")
	}
	payload, err := resolveText(*text, *file)
	if err != nil {
		return err
	}
	// Validate the target up front so a bad id is a clear message, not a crash.
	ok, err := w.PaneExists(*pane)
	if err != nil {
		return err
	}
	if !ok {
		return fmt.Errorf("pane %d not found — run `wezterm-bridge list` to see valid pane ids", *pane)
	}

	if *raise {
		if err := w.Activate(*pane); err != nil {
			return err
		}
	}
	if *esc {
		// One Esc to dismiss any open menu/permission prompt in the pane, then a
		// short settle so the TUI redraws to the prompt before we paste.
		if _, err := w.run("\x1b", "send-text", "--pane-id", strconv.Itoa(*pane), "--no-paste"); err != nil {
			return err
		}
		time.Sleep(time.Duration(*escDelay) * time.Millisecond)
	}
	if err := w.SendText(*pane, payload, *paste); err != nil {
		return err
	}
	if !*noSubmit {
		if err := w.Enter(*pane); err != nil {
			return err
		}
	}
	fmt.Printf("sent %d bytes to pane %d (submit=%v, raise=%v)\n", len(payload), *pane, !*noSubmit, *raise)

	if *capture {
		time.Sleep(500 * time.Millisecond)
		out, err := w.GetText(*pane)
		if err != nil {
			return err
		}
		fmt.Println("---- pane contents ----")
		fmt.Println(out)
	}
	return nil
}

// cmdDemoEcho proves spawn -> send -> submit -> capture with zero Claude
// variables: it spawns a fresh shell, sends a marker echo, and reads it back.
func cmdDemoEcho(w *wez, args []string) error {
	fs := flag.NewFlagSet("demo-echo", flag.ExitOnError)
	_ = fs.Parse(args)

	fmt.Println("[1/4] spawning a shell in a new WezTerm tab ...")
	pane, err := w.Spawn(false)
	if err != nil {
		return fmt.Errorf("spawn (is the WezTerm GUI running?): %w", err)
	}
	fmt.Printf("      new pane id = %d\n", pane)
	time.Sleep(1500 * time.Millisecond) // let the shell prompt appear

	marker := "WEZTERM_BRIDGE_OK_" + strconv.FormatInt(time.Now().Unix(), 10)
	fmt.Printf("[2/4] sending: echo %s\n", marker)
	if err := w.SendText(pane, "echo "+marker, true); err != nil {
		return err
	}
	fmt.Println("[3/4] pressing Enter ...")
	if err := w.Enter(pane); err != nil {
		return err
	}
	time.Sleep(800 * time.Millisecond)

	fmt.Println("[4/4] capturing pane and checking for the marker ...")
	out, err := w.GetText(pane)
	if err != nil {
		return err
	}
	// The marker appears twice (the typed command + its echoed output); the
	// command line ends in the literal "echo MARKER", so a standalone line
	// proves execution.
	if strings.Count(out, marker) >= 2 {
		fmt.Printf("\nPASS — command executed; marker '%s' found in pane output.\n", marker)
	} else {
		fmt.Printf("\nINCONCLUSIVE — marker count=%d. Pane dump:\n%s\n", strings.Count(out, marker), out)
	}
	return nil
}

// cmdDemoClaude is the headline demo: start Claude, wait for boot, send a prompt,
// wait, and capture the reply.
func cmdDemoClaude(w *wez, args []string) error {
	fs := flag.NewFlagSet("demo-claude", flag.ExitOnError)
	text := fs.String("text", "", "prompt to send")
	file := fs.String("file", "", "file whose contents to send as the prompt")
	pane := fs.Int("pane", 0, "use an EXISTING claude pane instead of spawning one")
	cwd := fs.String("cwd", "", "working dir to start claude in")
	boot := fs.Duration("boot", 60*time.Second, "how long to wait for claude to boot")
	settle := fs.Duration("settle", 8*time.Second, "how long to wait for a reply before capturing")
	bin := fs.String("claude", "claude", "claude binary/command")
	_ = fs.Parse(args)

	prompt, err := resolveText(*text, *file)
	if err != nil {
		return err
	}
	if strings.TrimSpace(prompt) == "" {
		return fmt.Errorf("empty prompt: pass -text or -file")
	}

	target := *pane
	if target == 0 {
		fmt.Printf("[1/4] spawning `%s` in a new WezTerm tab ...\n", *bin)
		prog := []string{*bin}
		var err error
		if *cwd != "" {
			target, err = w.spawnCwd(*cwd, prog...)
		} else {
			target, err = w.Spawn(false, prog...)
		}
		if err != nil {
			return fmt.Errorf("spawn claude (is the WezTerm GUI running?): %w", err)
		}
		fmt.Printf("      claude pane id = %d\n", target)
		fmt.Printf("[2/4] waiting %s for claude to boot ...\n", *boot)
		time.Sleep(*boot)
	} else {
		ok, err := w.PaneExists(target)
		if err != nil {
			return err
		}
		if !ok {
			return fmt.Errorf("pane %d not found — run `wezterm-bridge list`", target)
		}
		fmt.Printf("[1-2/4] using existing pane %d\n", target)
	}

	_ = w.Activate(target)
	fmt.Printf("[3/4] sending prompt (%d bytes) + Enter ...\n", len(prompt))
	if err := w.SendText(target, prompt, true); err != nil {
		return err
	}
	if err := w.Enter(target); err != nil {
		return err
	}

	fmt.Printf("[4/4] waiting %s, then capturing the pane ...\n", *settle)
	time.Sleep(*settle)
	out, err := w.GetText(target)
	if err != nil {
		return err
	}
	fmt.Println("---- claude pane ----")
	fmt.Println(out)
	return nil
}

// --- small helpers ---

func b64(s string) string { return base64.StdEncoding.EncodeToString([]byte(s)) }

func resolveText(text, file string) (string, error) {
	if file != "" {
		b, err := os.ReadFile(file)
		if err != nil {
			return "", fmt.Errorf("read -file: %w", err)
		}
		return string(b), nil
	}
	return text, nil
}

func getenv(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

func envInt(k string, def int) int {
	if v := os.Getenv(k); v != "" {
		if n, err := strconv.Atoi(strings.TrimSpace(v)); err == nil {
			return n
		}
	}
	return def
}

func envBool(k string) bool {
	switch strings.ToLower(strings.TrimSpace(os.Getenv(k))) {
	case "1", "true", "yes", "on":
		return true
	}
	return false
}
