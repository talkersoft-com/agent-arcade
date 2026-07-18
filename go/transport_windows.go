//go:build windows

package main

import (
	"errors"
	"net"
)

// Filled in by Phase 3 (go-winio ListenPipe). Present now so
// `GOOS=windows go build` compiles the daemon end to end.
func listenLocal() (net.Listener, error) {
	return nil, errors.New("windows named-pipe transport lands in phase 3")
}
