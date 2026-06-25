package main

import (
	"encoding/json"
	"os"
	"sync"
)

// emitter serializes NDJSON output to stdout. json.Encoder.Encode appends a
// newline after each object, giving us one JSON object per line. A mutex keeps
// concurrent emits (e.g. from the audio callback path vs. the command loop)
// from interleaving partial lines.
type emitter struct {
	mu  sync.Mutex
	enc *json.Encoder
}

func newEmitter() *emitter {
	return &emitter{enc: json.NewEncoder(os.Stdout)}
}

func (e *emitter) emit(m outMsg) {
	e.mu.Lock()
	defer e.mu.Unlock()
	_ = e.enc.Encode(m)
}
