// Command dictation-go is the dictation daemon for Agent Arcade.
//
// Capture happens in the Electron renderer (reliable mic + device selection);
// this binary owns the API side: health checks and uploading WAVs to the
// dictation API. ONE daemon serves every client (Studio, Arcade, launcher,
// smoke scripts) over a local transport — a Unix domain socket on macOS/Linux
// (~/.hv/dictation.sock), a named pipe on Windows
// (\\.\pipe\agent-arcade-dictation) — speaking NDJSON protocol v1, correlated
// by job_id. See docs/plans/daemon-ipc/PLAN.md.
//
//	client -> daemon:
//	  {"type":"hello","client":"arcade|studio|launcher|cli","app_version":"x.y.z","protocol":1}   (MUST be first)
//	  {"type":"health"}
//	  {"type":"dictate","job_id":"<id>","wav_path":"/tmp/x.wav","source":"mic|test"}
//	  {"type":"info"}
//	  {"type":"shutdown","reason":"user_restart|config_change|quit"}
//
//	daemon -> client:
//	  {"type":"welcome","daemon_version":"x.y.z","protocol":1,"api_url":"...","healthy":true}
//	  {"type":"stale","reason":"binary changed on disk"}   then the daemon exits 0
//	  {"type":"status","job_id":"<id>","state":"sending"}                     unicast to owner
//	  {"type":"result","job_id":"<id>","raw_text":"...","cleaned_text":"...","ms":574}  unicast
//	  {"type":"error","job_id":"<id>","stage":"...","error":"..."}            unicast
//	  {"type":"health_result","ok":true,"detail":"..."}                       broadcast
//	  {"type":"log","level":"info","job_id":"<id>?","msg":"..."}              broadcast
//	  {"type":"info_result","daemon_version":"...","uptime_s":123,"clients":["arcade"]}
//
// Modes: --daemon (serve) and --selftest [wav] (prove the API end-to-end, no
// sockets). Diagnostics go to stderr. API endpoint: DICTATION_API_URL.
package main

import (
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

	// --daemon: serve protocol v1 to many clients over the local socket/pipe.
	if len(os.Args) > 1 && (os.Args[1] == "--daemon" || os.Args[1] == "-daemon") {
		os.Exit(runDaemon(api, apiURL))
	}

	fmt.Fprintln(os.Stderr, "usage: dictation-go --daemon | --selftest [wav]")
	os.Exit(2)
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
