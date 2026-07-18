//go:build !windows

package main

import (
	"net"
	"os"
	"path/filepath"
)

// listenLocal binds the Unix-domain socket. A failed bind is disambiguated by
// dialing: an answering listener means a live daemon won the race
// (errDaemonRunning); a dead one means a stale file from a crashed daemon —
// unlink it and bind again. On clean Close() Go's UnixListener unlinks the
// socket file itself, so a successor can bind immediately.
func listenLocal() (net.Listener, error) {
	p := sockPath()
	_ = os.MkdirAll(filepath.Dir(p), 0o700)
	ln, err := net.Listen("unix", p)
	if err != nil {
		if c, derr := net.Dial("unix", p); derr == nil {
			c.Close()
			return nil, errDaemonRunning
		}
		_ = os.Remove(p)
		if ln, err = net.Listen("unix", p); err != nil {
			return nil, err
		}
	}
	_ = os.Chmod(p, 0o600) // single-user transport: owner only
	return ln, nil
}
