package gui

import (
	"context"
	"path/filepath"
	"testing"

	"github.com/yetone/magpie/internal/plugin"
)

// A local folder installs without downloading Bun. Its first page load must
// initialize the host or show the failure, rather than report no sign-in.
func TestLocalPluginColdStartAttemptsHostInitialization(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	t.Setenv("XDG_CACHE_HOME", t.TempDir())
	t.Setenv("MAGPIE_BUN", "")
	t.Setenv("MAGPIE_PLUGIN_MARKET", "off")
	t.Cleanup(plugin.Settle)
	abs, err := filepath.Abs("../plugin/testdata/fake/index.js")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := plugin.Add(context.Background(), abs); err != nil {
		t.Fatal(err)
	}
	if plugin.HasBun() {
		t.Fatal("fixture unexpectedly has a cached Bun")
	}
	// Cancel the cold start so no runtime or supplier is fetched in this test.
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	state := pluginsState(ctx, nil)
	if state.Error == "" {
		t.Fatal("a cold local plugin silently reports no sign-in instead of starting its host")
	}
}
