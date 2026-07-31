//go:build windows

package main

import (
	"net"
	"time"

	"github.com/Microsoft/go-winio"
)

// listenLocal binds the named pipe. No unlink dance — the OS removes a pipe
// with its creator, so there are no stale files. A failed bind means another
// daemon is live (or won the race this instant): confirm by dialing, then
// defer to the winner (errDaemonRunning → exit 0 upstream, same as unix).
func listenLocal() (net.Listener, error) {
	ln, err := winio.ListenPipe(pipeName(), &winio.PipeConfig{})
	if err == nil {
		return ln, nil
	}
	timeout := 2 * time.Second
	if c, derr := winio.DialPipe(pipeName(), &timeout); derr == nil {
		c.Close()
		return nil, errDaemonRunning
	}
	return nil, err
}

// localAddrPath: named pipes have no filesystem path to watch.
func localAddrPath() string { return "" }
