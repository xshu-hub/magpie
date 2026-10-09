package gateway

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/yetone/magpie/internal/plugin"
)

// This opt-in test runs Magpie's real gateway and plugin host, and the official
// unmodified OpenCode v1 binary. The upstream alone is a loopback fixture.
func TestOpenCodeV1Bridge(t *testing.T) {
	command := os.Getenv("TEST_OPENCODE_COMMAND")
	if command == "" {
		t.Skip("set TEST_OPENCODE_COMMAND to run the real OpenCode v1 bridge")
	}
	bun, err := exec.LookPath("bun")
	if err != nil {
		t.Fatal("the real OpenCode bridge check requires Bun")
	}
	fresh(t)
	t.Setenv("MAGPIE_BUN", bun)
	t.Cleanup(plugin.Settle)
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		if r.URL.Path != "/v1/chat/completions" || r.Header.Get("Authorization") != "Bearer fixture-key" || !strings.Contains(string(body), "gateway sentinel") {
			t.Errorf("unexpected OpenCode inference: %s %s", r.URL.Path, body)
		}
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprint(w, "data: "+`{"id":"fixture","object":"chat.completion.chunk","created":1,"model":"mock","choices":[{"index":0,"delta":{"role":"assistant","content":"Through real OpenCode v1"},"finish_reason":null}]}`+"\n\n")
		fmt.Fprint(w, "data: "+`{"id":"fixture","object":"chat.completion.chunk","created":1,"model":"mock","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}`+"\n\ndata: [DONE]\n\n")
	}))
	defer up.Close()
	var cmd []string
	if err := json.Unmarshal([]byte(command), &cmd); err != nil {
		t.Fatal(err)
	}
	config := map[string]any{
		"command": cmd, "timeoutMs": 60000,
		"models": map[string]any{"oc-mock": map[string]any{"protocol": "openai-chat", "baseURL": up.URL + "/v1", "id": "mock", "context": 100000, "output": 1000}},
	}
	b, _ := json.Marshal(config)
	file := filepath.Join(t.TempDir(), "bridge.json")
	if err := os.WriteFile(file, b, 0600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("MAGPIE_OPENCODE_CONFIG", file)
	addon, _ := filepath.Abs("../../addons/opencode-bridge")
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	if _, err := plugin.Add(ctx, addon); err != nil {
		t.Fatal(err)
	}
	if _, err := plugin.APIKey(ctx, "opencode-bridge", 0, nil, "fixture-key", plugin.NewAccount); err != nil {
		t.Fatal(err)
	}
	s := New()
	for _, stream := range []bool{false, true} {
		code, body := postAs(t, s, "", fmt.Sprintf(`{"model":"opencode-bridge/oc-mock","messages":[{"role":"user","content":"gateway sentinel"}],"stream":%t}`, stream))
		if code != 200 || !strings.Contains(body, "Through real OpenCode v1") {
			t.Fatalf("real gateway stream=%t: HTTP %d %s", stream, code, body)
		}
	}
}
