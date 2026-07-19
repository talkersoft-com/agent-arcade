package main

import (
	"os"
	"time"
)

// selfStat pins the identity (size+mtime) of the binary this process booted
// from. An npm upgrade replaces the file at the same path; a daemon that keeps
// serving from the old in-memory image would silently skew against the freshly
// installed clients. Instead of version negotiation, the daemon re-stats itself
// on every new connection and steps down when the file changed (locked
// decision #1 in docs/plans/daemon-ipc/PLAN.md).
type selfStat struct {
	path  string
	size  int64
	mtime time.Time
}

func recordSelf() *selfStat {
	exe, err := os.Executable()
	if err != nil {
		return &selfStat{} // unknown identity: never report stale
	}
	fi, err := os.Stat(exe)
	if err != nil {
		return &selfStat{path: exe}
	}
	return &selfStat{path: exe, size: fi.Size(), mtime: fi.ModTime()}
}

// changed reports whether the on-disk binary no longer matches the one this
// process booted from (replaced or deleted). Unknown boot identity → false.
func (s *selfStat) changed() bool {
	if s.path == "" {
		return false
	}
	fi, err := os.Stat(s.path)
	if err != nil {
		return true // vanished
	}
	return fi.Size() != s.size || !fi.ModTime().Equal(s.mtime)
}
