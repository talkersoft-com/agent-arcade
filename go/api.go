package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime/multipart"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"
)

// apiClient talks to the live voice-dictation-api over HTTP.
//
// NOTE: the alpha requirements named gRPC as the transport, but the live API's
// public contract is HTTP — POST /dictate (multipart "file") -> {raw_text,
// cleaned_text} and GET /health. gRPC is used only INSIDE the API (it -> Riva).
// So this client speaks the real, tested HTTP contract.
type apiClient struct {
	baseURL string
	http    *http.Client

	// Talkersoft ID access token (the wristband). Set by the client apps over
	// the socket (hello/token); attached as a Bearer header to work requests so
	// speech-api can verify. Guarded — updated live as tokens refresh.
	mu    sync.RWMutex
	token string
}

// setToken updates the current access token (empty string clears it).
func (c *apiClient) setToken(t string) {
	c.mu.Lock()
	c.token = t
	c.mu.Unlock()
}

// authHeader applies the current Bearer token to a request, if any.
func (c *apiClient) authHeader(req *http.Request) {
	c.mu.RLock()
	t := c.token
	c.mu.RUnlock()
	if t != "" {
		req.Header.Set("Authorization", "Bearer "+t)
	}
}

func newAPIClient(baseURL string) *apiClient {
	// This is a long-lived process, so the default transport's pooled keep-alive
	// connections can go stale during idle (NAT/firewall silently drops them).
	// Reusing a dead socket makes the next send hang until the overall timeout.
	// Guard against that: bound the dial, keep idle conns short-lived, and probe
	// liveness via TCP keep-alive so a dead connection fails fast instead of
	// freezing.
	transport := &http.Transport{
		DialContext: (&net.Dialer{
			// 5s connect budget: after sleep/wake the pooled conns to the API
			// are dead — a fresh dial must fail fast so the retry (below) can
			// land inside the user's patience window.
			Timeout:   5 * time.Second,
			KeepAlive: 30 * time.Second,
		}).DialContext,
		IdleConnTimeout:       30 * time.Second, // evict idle conns well before NAT drops them
		ResponseHeaderTimeout: 90 * time.Second, // a hung/half-open conn fails fast, not at 120s
		TLSHandshakeTimeout:   10 * time.Second,
		ExpectContinueTimeout: 1 * time.Second,
		MaxIdleConns:          4,
	}
	return &apiClient{
		baseURL: strings.TrimRight(baseURL, "/"),
		// Generous overall cap: the API's two NIM stages each have their own ~60s budget.
		http: &http.Client{Timeout: 120 * time.Second, Transport: transport},
	}
}

// stageError attributes a failure to a pipeline stage for clearer UI messaging.
type stageError struct {
	stage string
	err   error
}

func (e *stageError) Error() string { return fmt.Sprintf("%s: %v", e.stage, e.err) }
func (e *stageError) Unwrap() error { return e.err }

func asStageError(err error, target **stageError) bool { return errors.As(err, target) }

type dictateResponse struct {
	RawText     string   `json:"raw_text"`
	CleanedText string   `json:"cleaned_text"`
	Type        string   `json:"type"` // classified output type (requirements/command/reply/chat)
	Applied     []string `json:"applied"`
	Error       string   `json:"error"`
	Stage       string   `json:"stage"`
}

// dictate uploads a WAV to POST /dictate. dictationOptions is a comma-separated
// list of dictation-option keys; when non-empty it is sent as the "dictation_options"
// form field BEFORE the file part (the API reads fields ahead of the file). Returns
// raw/cleaned text and the option keys the server reports it applied.
func (c *apiClient) dictate(wav []byte, dictationOptions string, cleanup bool) (raw, cleaned, dtype string, applied []string, err error) {
	var body bytes.Buffer
	mw := multipart.NewWriter(&body)
	if dictationOptions != "" {
		if err := mw.WriteField("dictation_options", dictationOptions); err != nil {
			return "", "", "", nil, &stageError{"upload", err}
		}
	}
	if !cleanup {
		// Skip the AI cleanup layer — raw Parakeet transcription only.
		if err := mw.WriteField("cleanup", "false"); err != nil {
			return "", "", "", nil, &stageError{"upload", err}
		}
	}
	part, err := mw.CreateFormFile("file", "recording.wav")
	if err != nil {
		return "", "", "", nil, &stageError{"upload", err}
	}
	if _, err := part.Write(wav); err != nil {
		return "", "", "", nil, &stageError{"upload", err}
	}
	if err := mw.Close(); err != nil {
		return "", "", "", nil, &stageError{"upload", err}
	}

	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()

	// One retry on connection-level failure (refused/reset/dead pooled conn —
	// the post-sleep/wake signature). Do() erroring means NO response bytes
	// were received, so a resend cannot double-apply; a genuine deadline is
	// excluded so a slow transcription is never retried on top of itself.
	payload := body.Bytes()
	var resp *http.Response
	for attempt := 0; ; attempt++ {
		req, rerr := http.NewRequestWithContext(ctx, http.MethodPost, c.baseURL+"/dictate", bytes.NewReader(payload))
		if rerr != nil {
			return "", "", "", nil, &stageError{"upload", rerr}
		}
		req.Header.Set("Content-Type", mw.FormDataContentType())
		c.authHeader(req)
		resp, err = c.http.Do(req)
		if err == nil {
			break
		}
		if attempt == 0 && ctx.Err() == nil {
			continue
		}
		return "", "", "", nil, &stageError{"network", fmt.Errorf("cannot reach API at %s: %w", c.baseURL, err)}
	}
	defer resp.Body.Close()

	raw_body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))

	var out dictateResponse
	_ = json.Unmarshal(raw_body, &out)

	if resp.StatusCode != http.StatusOK {
		stage := out.Stage
		if stage == "" {
			stage = "api"
		}
		msg := out.Error
		if msg == "" {
			msg = snippet(raw_body)
		}
		return "", "", "", nil, &stageError{stage, fmt.Errorf("API returned %d: %s", resp.StatusCode, msg)}
	}
	return out.RawText, out.CleanedText, out.Type, out.Applied, nil
}

// healthy reports whether GET /health returns 200 (both NIMs ready).
// Retries once on connection error so a single dead pooled conn (sleep/wake)
// doesn't flicker availability off across every client.
func (c *apiClient) healthy() bool {
	for attempt := 0; attempt < 2; attempt++ {
		ctx, cancel := context.WithTimeout(context.Background(), 4*time.Second)
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.baseURL+"/health", nil)
		if err != nil {
			cancel()
			return false
		}
		resp, err := c.http.Do(req)
		cancel()
		if err != nil {
			continue
		}
		resp.Body.Close()
		return resp.StatusCode == http.StatusOK
	}
	return false
}

func snippet(b []byte) string {
	s := strings.TrimSpace(string(b))
	if len(s) > 200 {
		return s[:200] + "…"
	}
	return s
}
