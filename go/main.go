// Command dictation-go is the API/transport bridge for Agent Arcade Studio.
//
// Capture now happens in the Electron renderer (reliable mic + device selection
// on macOS); this binary owns the API side: health checks and uploading a WAV to
// the dictation API. It is a long-lived child of the Electron main process,
// driven over NDJSON (one JSON object per line) on stdin/stdout, correlated by
// job_id. It also has a standalone --selftest mode that proves the API works
// without Electron at all.
//
//	Electron -> Go (stdin):
//	  {"type":"health"}
//	  {"type":"dictate","job_id":"<id>","wav_path":"/tmp/x.wav","source":"mic|test"}
//
//	Go -> Electron (stdout):
//	  {"type":"ready","api_url":"...","healthy":true}
//	  {"type":"log","level":"info","msg":"..."}            human-readable progress
//	  {"type":"health_result","ok":true,"detail":"..."}
//	  {"type":"status","job_id":"<id>","state":"sending"}
//	  {"type":"result","job_id":"<id>","source":"mic","raw_text":"...","cleaned_text":"...","ms":574}
//	  {"type":"error","job_id":"<id>","stage":"...","error":"..."}
//
// Diagnostics also go to stderr. API endpoint: DICTATION_API_URL.
package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"time"
)

type inMsg struct {
	Type      string `json:"type"`
	JobID     string `json:"job_id"`
	WavPath   string `json:"wav_path"`
	Source    string `json:"source"`
	DictationOptions string `json:"dictation_options"` // comma-separated dictation-option keys
	Cleanup          *bool  `json:"cleanup"`           // nil = default on; false = skip AI cleanup layer

	// Daemon protocol v1 (hello/shutdown) — unused in stdio mode.
	Client     string `json:"client"`      // arcade | studio | launcher | cli
	AppVersion string `json:"app_version"`
	Protocol   int    `json:"protocol"`
	Reason     string `json:"reason"`
}

type outMsg struct {
	Type        string `json:"type"`
	JobID       string `json:"job_id,omitempty"`
	State       string `json:"state,omitempty"`
	Source      string `json:"source,omitempty"`
	RawText     string   `json:"raw_text,omitempty"`
	CleanedText string   `json:"cleaned_text,omitempty"`
	OutputType  string   `json:"output_type,omitempty"` // classified type (requirements/command/reply/chat)
	Applied     []string `json:"applied,omitempty"`
	MS          int64    `json:"ms,omitempty"`
	Stage       string `json:"stage,omitempty"`
	Error       string `json:"error,omitempty"`
	APIURL      string `json:"api_url,omitempty"`
	Healthy     *bool  `json:"healthy,omitempty"`
	OK          *bool  `json:"ok,omitempty"`
	Level       string `json:"level,omitempty"`
	Msg         string `json:"msg,omitempty"`
	Detail      string `json:"detail,omitempty"`

	// Daemon protocol v1 (welcome/stale/info_result) — unused in stdio mode.
	DaemonVersion string   `json:"daemon_version,omitempty"`
	Protocol      int      `json:"protocol,omitempty"`
	UptimeS       int64    `json:"uptime_s,omitempty"`
	Clients       []string `json:"clients,omitempty"`
	Reason        string   `json:"reason,omitempty"`
}

func main() {
	// API endpoint is REQUIRED — no host is hardcoded. The Electron apps pass this
	// from the YAML `api_url:`; standalone runs must set DICTATION_API_URL.
	apiURL := strings.TrimSpace(os.Getenv("DICTATION_API_URL"))
	if apiURL == "" {
		fmt.Fprintln(os.Stderr, "DICTATION_API_URL is not set — configure api_url in ~/.hv/dictate-settings.yaml (or set the env var for standalone runs)")
		os.Exit(2)
	}
	api := newAPIClient(apiURL)

	// --selftest <wav>: prove the API end-to-end from the same Go HTTP code the
	// app uses, no Electron, no mic. Exit 0 on success, 1 on failure.
	if len(os.Args) > 1 && (os.Args[1] == "--selftest" || os.Args[1] == "-selftest") {
		os.Exit(runSelftest(api, apiURL, os.Args[2:]))
	}

	// --daemon: serve protocol v1 to many clients over the local socket/pipe
	// (see docs/plans/daemon-ipc/PLAN.md). The stdio mode below stays intact
	// until Phase 4 retires it.
	if len(os.Args) > 1 && (os.Args[1] == "--daemon" || os.Args[1] == "-daemon") {
		os.Exit(runDaemon(api, apiURL))
	}

	out := newEmitter()
	log := func(format string, a ...any) {
		msg := fmt.Sprintf(format, a...)
		out.emit(outMsg{Type: "log", Level: "info", Msg: msg})
		fmt.Fprintln(os.Stderr, "dictation-go:", msg)
	}

	healthy := api.healthy()
	out.emit(outMsg{Type: "ready", APIURL: apiURL, Healthy: &healthy})
	log("ready — api=%s healthy=%v", apiURL, healthy)

	scanner := bufio.NewScanner(os.Stdin)
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}
		var msg inMsg
		if err := json.Unmarshal([]byte(line), &msg); err != nil {
			out.emit(outMsg{Type: "error", Stage: "protocol", Error: "bad json: " + err.Error()})
			continue
		}
		switch msg.Type {
		case "health":
			ok := api.healthy()
			detail := apiURL
			if !ok {
				detail = "no 200 from " + apiURL + "/health"
			}
			out.emit(outMsg{Type: "health_result", OK: &ok, Detail: detail})
			log("health check: ok=%v (%s)", ok, apiURL)
		case "dictate":
			handleDictate(out, log, api, msg)
		default:
			out.emit(outMsg{Type: "error", JobID: msg.JobID, Stage: "protocol", Error: "unknown type: " + msg.Type})
		}
	}
}

func handleDictate(out sink, log func(string, ...any), api *apiClient, msg inMsg) {
	src := msg.Source
	if src == "" {
		src = "mic"
	}
	wav, err := os.ReadFile(msg.WavPath)
	if err != nil {
		out.emit(outMsg{Type: "error", JobID: msg.JobID, Source: src, Stage: "read", Error: "read wav: " + err.Error()})
		return
	}
	log("[%s] uploading %d bytes to /dictate", src, len(wav))
	out.emit(outMsg{Type: "status", JobID: msg.JobID, Source: src, State: "sending"})

	if msg.DictationOptions != "" {
		log("[%s] dictation_options: %s", src, msg.DictationOptions)
	}
	t0 := time.Now()
	cleanup := msg.Cleanup == nil || *msg.Cleanup // default on
	raw, cleaned, dtype, applied, err := api.dictate(wav, msg.DictationOptions, cleanup)
	ms := time.Since(t0).Milliseconds()
	if err != nil {
		stage := "transcribe"
		var se *stageError
		if asStageError(err, &se) {
			stage = se.stage
		}
		log("[%s] FAILED after %dms: %s", src, ms, err.Error())
		out.emit(outMsg{Type: "error", JobID: msg.JobID, Source: src, Stage: stage, Error: err.Error(), MS: ms})
		return
	}
	log("[%s] ok in %dms: %q", src, ms, cleaned)
	out.emit(outMsg{Type: "result", JobID: msg.JobID, Source: src, RawText: raw, CleanedText: cleaned, OutputType: dtype, Applied: applied, MS: ms})
}

func runSelftest(api *apiClient, apiURL string, args []string) int {
	wav := "testdata/sample.wav"
	if len(args) > 0 {
		wav = args[0]
	}
	fmt.Printf("== dictation-go selftest ==\nAPI: %s\n\n", apiURL)

	fmt.Print("[1/2] GET /health ... ")
	if !api.healthy() {
		fmt.Printf("FAIL (no 200 from %s/health)\n", apiURL)
		return 1
	}
	fmt.Println("ok (200)")

	fmt.Printf("[2/2] POST /dictate (%s) ... ", wav)
	data, err := os.ReadFile(wav)
	if err != nil {
		fmt.Printf("FAIL (read %s: %v)\n", wav, err)
		return 1
	}
	t0 := time.Now()
	raw, cleaned, _, _, err := api.dictate(data, "", true)
	if err != nil {
		fmt.Printf("FAIL (%v)\n", err)
		return 1
	}
	fmt.Printf("ok in %dms\n\n  raw_text:     %q\n  cleaned_text: %q\n\nPASS — API is working.\n",
		time.Since(t0).Milliseconds(), raw, cleaned)
	return 0
}
