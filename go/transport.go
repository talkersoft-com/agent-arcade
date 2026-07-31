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

// The daemon is SINGLE-TENANT by construction: one apiURL, one token, one socket
// (see hub.go). It was never built to serve two configurations at once, and
// making it do so would mean moving the backend and the access token to
// per-connection state — putting cloud auth code inside a free user's process,
// where a bug in it can take down on-device dictation.
//
// So the two editions get their own daemons instead, distinguished exactly the
// way dev and prod already are: by the address they bind. Different addresses
// means they coexist; the SAME address means the ownership watchdog makes one of
// them step down (hub.go), which is precisely what must not happen between a
// free and a paid instance.
//
// An unset edition keeps the legacy name, so a standalone `--daemon` run and any
// client from an older build still find each other.
func addrSuffix() string {
	dev := os.Getenv("DICTATE_DEV") != ""
	part := ""
	switch os.Getenv("DICTATION_EDITION") {
	case "local":
		part = ".local"
	case "cloud":
		part = ".cloud"
	}
	if dev {
		part += ".dev"
	}
	return part
}

// sockPath is the Unix-domain socket address (macOS/Linux).
func sockPath() string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".hv", "dictation"+addrSuffix()+".sock")
}

// pipeName is the Windows named-pipe address (same split).
func pipeName() string {
	return `\\.\pipe\agent-arcade-dictation` + addrSuffix()
}
