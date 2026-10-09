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
	"sync/atomic"
	"testing"
	"time"

	"github.com/yetone/magpie/internal/plugin"
	"github.com/yetone/magpie/internal/provider"
)

// This opt-in test runs Magpie's real gateway and plugin host, and the official
// unmodified OpenCode v1 binary. The upstream alone is a loopback fixture.
func TestOpenCodeV1Bridge(t *testing.T) {
	for _, global := range []bool{false, true} {
		name := "isolated"
		if global {
			name = "global"
		}
		t.Run(name, func(t *testing.T) { testOpenCodeV1Bridge(t, global) })
	}
}

func testOpenCodeV1Bridge(t *testing.T, global bool) {
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
	var calls atomic.Int32
	var concurrentCalls atomic.Int32
	concurrentRelease := make(chan struct{})
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		body, _ := io.ReadAll(r.Body)
		if r.URL.Path != "/v1/chat/completions" || r.Header.Get("Authorization") != "Bearer fixture-key" || !strings.Contains(string(body), "gateway sentinel") {
			t.Errorf("unexpected OpenCode inference: %s %s", r.URL.Path, body)
		}
		w.Header().Set("Content-Type", "text/event-stream")
		var input struct {
			Tools []struct {
				Function struct{ Name string }
			}
			Messages []struct{ Role, Content string }
		}
		if err := json.Unmarshal(body, &input); err != nil {
			t.Error(err)
		}
		hasResult := false
		content := "Through real OpenCode v1"
		for _, msg := range input.Messages {
			hasResult = hasResult || msg.Role == "tool"
			if strings.HasPrefix(msg.Content, "gateway sentinel parallel ") {
				content = msg.Content
				if concurrentCalls.Add(1) == 4 {
					close(concurrentRelease)
				}
				select {
				case <-concurrentRelease:
				case <-r.Context().Done():
					return
				}
			}
		}
		if len(input.Tools) > 0 && !hasResult {
			name, _ := json.Marshal(input.Tools[0].Function.Name)
			fmt.Fprint(w, "data: "+`{"id":"fixture","object":"chat.completion.chunk","created":1,"model":"mock","choices":[{"index":0,"delta":{"role":"assistant","tool_calls":[{"index":0,"id":"call_fixture","type":"function","function":{"name":`+string(name)+`,"arguments":"{\"city\":\"Beijing\"}"}}]},"finish_reason":null}]}`+"\n\n")
			fmt.Fprint(w, "data: "+`{"id":"fixture","object":"chat.completion.chunk","created":1,"model":"mock","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}`+"\n\ndata: [DONE]\n\n")
			return
		}
		text, _ := json.Marshal(content)
		fmt.Fprint(w, "data: "+`{"id":"fixture","object":"chat.completion.chunk","created":1,"model":"mock","choices":[{"index":0,"delta":{"role":"assistant","content":`+string(text)+`},"finish_reason":null}]}`+"\n\n")
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
	addon, _ := filepath.Abs("../../addons/opencode-bridge")
	if global {
		t.Setenv("XDG_DATA_HOME", t.TempDir())
		t.Setenv("XDG_STATE_HOME", t.TempDir())
		for _, key := range []string{"OPENCODE_CONFIG", "OPENCODE_CONFIG_DIR", "OPENCODE_CONFIG_CONTENT", "OPENCODE_AUTH_CONTENT"} {
			t.Setenv(key, "")
		}
		t.Setenv("OPENCODE_DISABLE_MODELS_FETCH", "1")
		dir := filepath.Join(os.Getenv("XDG_CONFIG_HOME"), "opencode")
		if err := os.MkdirAll(dir, 0700); err != nil {
			t.Fatal(err)
		}
		sdk := os.Getenv("TEST_OPENCODE_PLUGIN_DIR")
		if sdk == "" {
			sdk = filepath.Join(addon, "node_modules", "@opencode-ai", "plugin")
		}
		if err := os.CopyFS(filepath.Join(dir, "node_modules", "@opencode-ai", "plugin"), os.DirFS(sdk)); err != nil {
			t.Fatal(err)
		}
		write := func(file string, value any) {
			t.Helper()
			if err := os.MkdirAll(filepath.Dir(file), 0700); err != nil {
				t.Fatal(err)
			}
			b, err := json.Marshal(value)
			if err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(file, b, 0600); err != nil {
				t.Fatal(err)
			}
		}
		manifest, err := os.ReadFile(filepath.Join(sdk, "package.json"))
		if err != nil {
			t.Fatal(err)
		}
		var pkg struct{ Version string }
		if err := json.Unmarshal(manifest, &pkg); err != nil || pkg.Version == "" {
			t.Fatalf("OpenCode SDK manifest: %v", err)
		}
		deps := map[string]string{"@opencode-ai/plugin": pkg.Version}
		write(filepath.Join(dir, "package.json"), map[string]any{"private": true, "dependencies": deps})
		write(filepath.Join(dir, "package-lock.json"), map[string]any{"lockfileVersion": 3, "packages": map[string]any{"": map[string]any{"dependencies": deps}, "node_modules/@opencode-ai/plugin": map[string]any{"version": pkg.Version}}})
		write(filepath.Join(dir, "opencode.json"), map[string]any{
			"$schema": "https://opencode.ai/config.json", "model": "fixture-global/mock",
			"provider": map[string]any{"fixture-global": map[string]any{
				"npm": "@ai-sdk/openai-compatible", "options": map[string]any{"baseURL": up.URL + "/v1"},
				"models": map[string]any{"mock": map[string]any{"limit": map[string]int{"context": 100000, "output": 1000}}},
			}},
		})
		write(filepath.Join(os.Getenv("XDG_DATA_HOME"), "opencode", "auth.json"), map[string]any{"fixture-global": map[string]string{"type": "api", "key": "fixture-key"}})
		config["mode"] = "global"
		// No model aliases: the plugin must discover the real global provider.
		delete(config, "models")
	}
	b, _ := json.Marshal(config)
	// PowerShell can save JSON with a UTF-8 BOM; the installed plugin accepts it.
	b = append([]byte("\xef\xbb\xbf"), b...)
	file := filepath.Join(t.TempDir(), "bridge.json")
	if err := os.WriteFile(file, b, 0600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("MAGPIE_OPENCODE_CONFIG", file)
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	// A previous test may leave a provider cache. Installation invalidates it
	// asynchronously, as it does when adding a plugin to a running Magpie.
	plugin.UseCached([]plugin.Provider{})
	t.Cleanup(func() { plugin.UseCached(nil) })
	if _, err := plugin.Add(ctx, addon); err != nil {
		t.Fatal(err)
	}
	// Wait for the real host's model registration before signing in or asking
	// the gateway. Cached() may serve the prior list while it refreshes.
	if _, err := plugin.Providers(ctx); err != nil {
		t.Fatal(err)
	}
	if global {
		st, err := provider.StartPluginSignIn("opencode-bridge", 0, nil)
		if err != nil {
			t.Fatal(err)
		}
		deadline := time.Now().Add(10 * time.Second)
		for {
			status, ok := provider.SignInStatus(st.ID)
			if !ok || status.State == "failed" || status.State == "canceled" {
				t.Fatalf("global OpenCode activation: %+v", status)
			}
			if status.State == "done" {
				break
			}
			if time.Now().After(deadline) {
				t.Fatal("global OpenCode activation did not finish")
			}
			time.Sleep(25 * time.Millisecond)
		}
	} else {
		if _, err := provider.PluginAPIKey(ctx, "opencode-bridge", 0, nil, "fixture-key"); err != nil {
			t.Fatal(err)
		}
	}
	s := New()
	gw := httptest.NewServer(lanGuard(s.Handler()))
	defer gw.Close()
	ask := func(body string) (int, string) {
		t.Helper()
		if global {
			body = strings.ReplaceAll(body, "opencode-bridge/oc-mock", "opencode-bridge/fixture-global/mock")
		}
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
		code, body := ask(fmt.Sprintf(`{"model":"opencode-bridge/oc-mock","messages":[{"role":"user","content":"Hello"},{"role":"assistant","content":"Previous answer","reasoning_content":""},{"role":"user","content":"gateway sentinel"}],"stream":%t}`, stream))
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
	if calls.Load() != 4 {
		t.Fatalf("four client requests caused %d upstream inferences", calls.Load())
	}
	// All four upstream calls must be active before the fixture releases any
	// output. This exercises concurrency through the real Bun host and gateway.
	parallelCtx, parallelCancel := context.WithTimeout(ctx, 45*time.Second)
	defer parallelCancel()
	results := make(chan error, 4)
	for i := range 4 {
		go func() {
			marker := fmt.Sprintf("gateway sentinel parallel %d", i)
			model := "opencode-bridge/oc-mock"
			if global {
				model = "opencode-bridge/fixture-global/mock"
			}
			body := fmt.Sprintf(`{"model":%q,"messages":[{"role":"user","content":%q}],"stream":%t}`, model, marker, i%2 == 0)
			req, err := http.NewRequestWithContext(parallelCtx, http.MethodPost, gw.URL+"/v1/chat/completions", strings.NewReader(body))
			if err != nil {
				results <- err
				return
			}
			req.Header.Set("Authorization", "Bearer fixture-client")
			req.Header.Set("Content-Type", "application/json")
			res, err := http.DefaultClient.Do(req)
			if err != nil {
				results <- err
				return
			}
			reply, err := io.ReadAll(res.Body)
			res.Body.Close()
			if err != nil {
				results <- err
				return
			}
			if res.StatusCode != http.StatusOK || !strings.Contains(string(reply), marker) {
				results <- fmt.Errorf("concurrent request %d: HTTP %d %s", i, res.StatusCode, reply)
				return
			}
			results <- nil
		}()
	}
	for range 4 {
		if err := <-results; err != nil {
			parallelCancel()
			t.Error(err)
		}
	}
	if calls.Load() != 8 || concurrentCalls.Load() != 4 {
		t.Errorf("eight client requests caused %d upstream inferences, %d concurrent", calls.Load(), concurrentCalls.Load())
	}
}
