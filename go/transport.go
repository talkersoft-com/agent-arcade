package main

import (
	"errors"
	"os"
	"path/filepath"
)

// The local address doubles as the single-instance lock: whoever binds it IS
// the daemon; a second binder must exit 0 silently (locked decision #3).
// Platform listeners live in transport_unix.go / transport_windows.go.
var errDaemonRunning = errors.New("another daemon already owns the local address")

// sockPath is the Unix-domain socket address (macOS/Linux). The dev build
// (DICTATE_DEV) gets its own socket so `npm run dev` never hijacks the
// production daemon, mirroring the split settings files.
func sockPath() string {
	name := "dictation.sock"
	if os.Getenv("DICTATE_DEV") != "" {
		name = "dictation.dev.sock"
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".hv", name)
}

// pipeName is the Windows named-pipe address (same dev split).
func pipeName() string {
	if os.Getenv("DICTATE_DEV") != "" {
		return `\\.\pipe\agent-arcade-dictation-dev`
	}
	return `\\.\pipe\agent-arcade-dictation`
}
