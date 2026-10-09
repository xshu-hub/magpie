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
	"github.com/yetone/magpie/internal/provider"
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
		var input struct {
			Tools []struct {
				Function struct{ Name string }
			}
			Messages []struct{ Role string }
		}
		if err := json.Unmarshal(body, &input); err != nil {
			t.Error(err)
		}
		hasResult := false
		for _, msg := range input.Messages {
			hasResult = hasResult || msg.Role == "tool"
		}
		if len(input.Tools) > 0 && !hasResult {
			name, _ := json.Marshal(input.Tools[0].Function.Name)
			fmt.Fprint(w, "data: "+`{"id":"fixture","object":"chat.completion.chunk","created":1,"model":"mock","choices":[{"index":0,"delta":{"role":"assistant","tool_calls":[{"index":0,"id":"call_fixture","type":"function","function":{"name":`+string(name)+`,"arguments":"{\"city\":\"Beijing\"}"}}]},"finish_reason":null}]}`+"\n\n")
			fmt.Fprint(w, "data: "+`{"id":"fixture","object":"chat.completion.chunk","created":1,"model":"mock","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}`+"\n\ndata: [DONE]\n\n")
			return
		}
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
	if _, err := provider.PluginAPIKey(ctx, "opencode-bridge", 0, nil, "fixture-key"); err != nil {
		t.Fatal(err)
	}
	s := New()
	gw := httptest.NewServer(lanGuard(s.Handler()))
	defer gw.Close()
	ask := func(body string) (int, string) {
		t.Helper()
		req, _ := http.NewRequestWithContext(ctx, http.MethodPost, gw.URL+"/v1/chat/completions", strings.NewReader(body))
		req.Header.Set("Authorization", "Bearer fixture-client")
		req.Header.Set("Content-Type", "application/json")
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		reply, err := io.ReadAll(res.Body)
		res.Body.Close()
		if err != nil {
			t.Fatal(err)
		}
		return res.StatusCode, string(reply)
	}
	for _, stream := range []bool{false, true} {
		code, body := ask(fmt.Sprintf(`{"model":"opencode-bridge/oc-mock","messages":[{"role":"user","content":"gateway sentinel"}],"stream":%t}`, stream))
		if code != 200 || !strings.Contains(body, "Through real OpenCode v1") {
			t.Fatalf("real gateway stream=%t: HTTP %d %s", stream, code, body)
		}
	}
	tools := `[{"type":"function","function":{"name":"weather","strict":false,"parameters":{"type":"object","properties":{"city":{"type":"string"}},"required":["city"],"additionalProperties":false}}}]`
	user := `{"role":"user","content":"gateway sentinel tool"}`
	code, body := ask(`{"model":"opencode-bridge/oc-mock","messages":[` + user + `],"tools":` + tools + `}`)
	if code != 200 || !strings.Contains(body, `"finish_reason":"tool_calls"`) || !strings.Contains(body, `"name":"weather"`) {
		t.Fatalf("real gateway tool batch: HTTP %d %s", code, body)
	}
	var result struct {
		Choices []struct{ Message json.RawMessage }
	}
	if err := json.Unmarshal([]byte(body), &result); err != nil || len(result.Choices) != 1 {
		t.Fatalf("tool batch: %v %s", err, body)
	}
	code, body = ask(`{"model":"opencode-bridge/oc-mock","messages":[` + user + `,` + string(result.Choices[0].Message) + `,{"role":"tool","tool_call_id":"call_fixture","content":"23C"}],"tools":` + tools + `}`)
	if code != 200 || !strings.Contains(body, "Through real OpenCode v1") {
		t.Fatalf("real gateway tool continuation: HTTP %d %s", code, body)
	}
}
