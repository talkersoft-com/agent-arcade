package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"net"
	"os"
	"strings"
	"sync"
	"time"
)

// tokenState describes a token for logging without ever printing it.
func tokenState(t string) string {
	if t == "" {
		return "cleared"
	}
	return "set"
}

// version is stamped at build time: -ldflags "-X main.version=x.y.z" (from
// package.json via the build:go script). Observability only — staleness is
// detected by self-stat, never by comparing versions.
var version = "dev"

const protocolVersion = 1

// sink is where a dictation job's events go — jobSink routes them to the
// owning connection. (An interface, not *hubClient, so tests or future modes
// can capture events without a live socket.)
type sink interface {
	emit(outMsg)
}

// hubClient is one connected app (arcade / studio / launcher / cli smoke
// script). The write mutex keeps concurrent emits (job goroutines, broadcasts)
// from interleaving partial NDJSON lines — same role the stdout emitter mutex
// plays in stdio mode.
type hubClient struct {
	conn   net.Conn
	mu     sync.Mutex
	enc    *json.Encoder
	name   string
	appVer string
}

func (c *hubClient) emit(m outMsg) {
	c.mu.Lock()
	defer c.mu.Unlock()
	_ = c.conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
	_ = c.enc.Encode(m)
}

type daemon struct {
	api    *apiClient
	apiURL string
	self   *selfStat
	start  time.Time
	ln     net.Listener

	mu      sync.Mutex
	conns   map[*hubClient]bool
	jobs    map[string]*hubClient // job_id → owning connection
	healthy bool

	jobsWG   sync.WaitGroup
	quitOnce sync.Once
}

// runDaemon serves protocol v1 on the local socket/pipe until a shutdown
// request or a staleness self-detection. Returns the process exit code.
func runDaemon(api *apiClient, apiURL string) int {
	ln, err := listenLocal()
	if err == errDaemonRunning {
		// Lost the bind race — the winner serves everyone (locked decision #3).
		fmt.Fprintln(os.Stderr, "dictation-go: daemon already running — exiting")
		return 0
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "dictation-go: cannot listen:", err)
		return 1
	}
	d := &daemon{
		api:    api,
		apiURL: apiURL,
		self:   recordSelf(),
		start:  time.Now(),
		ln:     ln,
		conns:  make(map[*hubClient]bool),
		jobs:   make(map[string]*hubClient),
	}
	d.healthy = api.healthy()
	fmt.Fprintf(os.Stderr, "dictation-go: daemon v%s listening (api=%s healthy=%v)\n", version, apiURL, d.healthy)

	for {
		conn, err := ln.Accept()
		if err != nil {
			break // listener closed by shutdown/staleness
		}
		go d.serve(conn)
	}

	// Drain in-flight jobs, bounded — a wedged upload must not trap the old
	// binary forever after an upgrade.
	done := make(chan struct{})
	go func() { d.jobsWG.Wait(); close(done) }()
	select {
	case <-done:
	case <-time.After(10 * time.Second):
		fmt.Fprintln(os.Stderr, "dictation-go: drain timed out — exiting with jobs in flight")
	}
	d.mu.Lock()
	for c := range d.conns {
		c.conn.Close()
	}
	d.mu.Unlock()
	fmt.Fprintln(os.Stderr, "dictation-go: daemon exited")
	return 0
}

func (d *daemon) beginShutdown(reason string) {
	d.quitOnce.Do(func() {
		fmt.Fprintln(os.Stderr, "dictation-go: shutting down:", reason)
		d.ln.Close() // unblocks Accept; UnixListener unlinks the socket file
	})
}

func (d *daemon) serve(conn net.Conn) {
	c := &hubClient{conn: conn, enc: json.NewEncoder(conn)}
	sc := bufio.NewScanner(conn)
	sc.Buffer(make([]byte, 0, 64*1024), 1024*1024)

	// Protocol gate: the first line MUST be hello. Anything else is a stray
	// writer (nc, a confused client) — refuse and drop.
	var hello inMsg
	if !sc.Scan() || json.Unmarshal([]byte(sc.Text()), &hello) != nil || hello.Type != "hello" {
		c.emit(outMsg{Type: "error", Stage: "protocol", Error: "first message must be hello"})
		conn.Close()
		return
	}
	c.name = hello.Client
	c.appVer = hello.AppVersion
	// A client may carry the Talkersoft ID access token in hello; apply it so the
	// very first dictation is authenticated. Empty tokens never clear a good one
	// (a launcher/cli connecting without auth mustn't wipe Studio's token).
	if hello.Token != "" {
		d.api.setToken(hello.Token)
	}

	// Staleness check before welcome (locked decision #1): a replaced binary
	// answers `stale` and steps down; the client's respawn-by-path lands on the
	// new one. Existing connections just see EOF and reconnect.
	if d.self.changed() {
		c.emit(outMsg{Type: "stale", Reason: "binary changed on disk"})
		conn.Close()
		d.beginShutdown("binary changed on disk")
		return
	}

	d.mu.Lock()
	d.conns[c] = true
	healthy := d.healthy
	d.mu.Unlock()
	defer d.dropClient(c)

	c.emit(outMsg{Type: "welcome", DaemonVersion: version, Protocol: protocolVersion, APIURL: d.apiURL, Healthy: &healthy})
	fmt.Fprintf(os.Stderr, "dictation-go: client connected: %s %s\n", c.name, c.appVer)

	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" {
			continue
		}
		var msg inMsg
		if err := json.Unmarshal([]byte(line), &msg); err != nil {
			c.emit(outMsg{Type: "error", Stage: "protocol", Error: "bad json: " + err.Error()})
			continue
		}
		switch msg.Type {
		case "health":
			go d.checkHealth()
		case "dictate":
			d.startJob(c, msg)
		case "info":
			c.emit(d.infoResult())
		case "token":
			// Live token update (login, refresh, or logout→empty). Shared across
			// all clients — whoever holds the identity sets it for every window.
			d.api.setToken(msg.Token)
			fmt.Fprintf(os.Stderr, "dictation-go: access token %s (from %s)\n", tokenState(msg.Token), c.name)
		case "shutdown":
			reason := msg.Reason
			if reason == "" {
				reason = "client request"
			}
			d.beginShutdown("shutdown: " + reason + " (from " + c.name + ")")
			return
		default:
			c.emit(outMsg{Type: "error", JobID: msg.JobID, Stage: "protocol", Error: "unknown type: " + msg.Type})
		}
	}
}

// dropClient deregisters a disconnected client and orphans its jobs: results
// for an owner that went away are dropped, exactly like stdio mode where the
// pipe died with the app (locked decision #7).
func (d *daemon) dropClient(c *hubClient) {
	c.conn.Close()
	d.mu.Lock()
	delete(d.conns, c)
	for id, owner := range d.jobs {
		if owner == c {
			delete(d.jobs, id)
		}
	}
	d.mu.Unlock()
	fmt.Fprintf(os.Stderr, "dictation-go: client disconnected: %s\n", c.name)
}

func (d *daemon) broadcast(m outMsg) {
	d.mu.Lock()
	targets := make([]*hubClient, 0, len(d.conns))
	for c := range d.conns {
		targets = append(targets, c)
	}
	d.mu.Unlock()
	for _, c := range targets {
		c.emit(m)
	}
}

// checkHealth probes the API and broadcasts the shared truth to every client
// (all apps show the same availability, no matter who asked).
func (d *daemon) checkHealth() {
	ok := d.api.healthy()
	d.mu.Lock()
	d.healthy = ok
	d.mu.Unlock()
	detail := d.apiURL
	if !ok {
		detail = "no 200 from " + d.apiURL + "/health"
	}
	d.broadcast(outMsg{Type: "health_result", OK: &ok, Detail: detail})
	fmt.Fprintf(os.Stderr, "dictation-go: health check: ok=%v (%s)\n", ok, d.apiURL)
}

func (d *daemon) infoResult() outMsg {
	d.mu.Lock()
	clients := make([]string, 0, len(d.conns))
	for c := range d.conns {
		clients = append(clients, c.name)
	}
	d.mu.Unlock()
	return outMsg{
		Type:          "info_result",
		DaemonVersion: version,
		Protocol:      protocolVersion,
		UptimeS:       int64(time.Since(d.start).Seconds()),
		Clients:       clients,
	}
}

// jobSink routes a job's status/result/error to the owning connection —
// unicast, and dropped silently once the owner disconnected.
type jobSink struct {
	d     *daemon
	jobID string
}

func (s *jobSink) emit(m outMsg) {
	s.d.mu.Lock()
	owner := s.d.jobs[s.jobID]
	s.d.mu.Unlock()
	if owner != nil {
		owner.emit(m)
	}
}

// startJob runs one dictation per goroutine — jobs from different windows no
// longer serialize behind each other the way the stdio stdin loop forced.
func (d *daemon) startJob(c *hubClient, msg inMsg) {
	d.mu.Lock()
	d.jobs[msg.JobID] = c
	d.mu.Unlock()
	d.jobsWG.Add(1)
	go func() {
		defer d.jobsWG.Done()
		sink := &jobSink{d: d, jobID: msg.JobID}
		logf := func(format string, a ...any) {
			text := fmt.Sprintf(format, a...)
			// Progress logs are observability, not routing: broadcast with the
			// job_id attached so any client can attribute them.
			d.broadcast(outMsg{Type: "log", Level: "info", JobID: msg.JobID, Msg: text})
			fmt.Fprintln(os.Stderr, "dictation-go:", text)
		}
		handleDictate(sink, logf, d.api, msg)
		d.mu.Lock()
		delete(d.jobs, msg.JobID)
		d.mu.Unlock()
	}()
}
