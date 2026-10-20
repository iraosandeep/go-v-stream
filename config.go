package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
)

// Config remembers the last folder picked in the UI. The file is shared with the Bun version of v-stream.
type Config struct {
	Root   string   `json:"root,omitempty"`
	Recent []string `json:"recent,omitempty"`
}

const maxRecent = 8

func configPath() string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".config", "v-stream", "config.json")
}

func loadConfig() *Config {
	cfg := &Config{}
	if b, err := os.ReadFile(configPath()); err == nil {
		_ = json.Unmarshal(b, cfg)
	}
	return cfg
}

func (c *Config) save() error {
	p := configPath()
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		return err
	}
	b, _ := json.MarshalIndent(c, "", "  ")
	return os.WriteFile(p, b, 0o644)
}

// expandHome turns "~" / "~/x" into an absolute path under the user's home directory.
func expandHome(p string) string {
	if p == "~" || strings.HasPrefix(p, "~/") {
		home, _ := os.UserHomeDir()
		return filepath.Join(home, p[1:])
	}
	return p
}

// canonicalDir resolves p to an absolute, symlink-free directory path.
func canonicalDir(p string) (string, error) {
	abs, err := filepath.Abs(expandHome(p))
	if err != nil {
		return "", err
	}
	resolved, err := filepath.EvalSymlinks(abs)
	if err != nil {
		return "", fmt.Errorf("not found: %s", abs)
	}
	st, err := os.Stat(resolved)
	if err != nil {
		return "", err
	}
	if !st.IsDir() {
		return "", fmt.Errorf("not a folder: %s", abs)
	}
	return resolved, nil
}

// resolveRoot picks the folder to serve: CLI argument, then MEDIA_DIR, then the saved folder,
// then ~/Movies, then home. A saved folder may be gone (e.g. the drive is unplugged), so it
// falls back quietly; an explicit argument that doesn't exist is an error.
func resolveRoot(arg, env string, cfg *Config) (string, error) {
	if explicit := firstNonEmpty(arg, env); explicit != "" {
		return canonicalDir(explicit)
	}
	home, _ := os.UserHomeDir()
	for _, candidate := range []string{cfg.Root, filepath.Join(home, "Movies"), filepath.Join(home, "Videos"), home} {
		if candidate == "" {
			continue
		}
		if dir, err := canonicalDir(candidate); err == nil {
			return dir, nil
		}
	}
	return "", errors.New("no folder to serve; pass one: vstream /path/to/videos")
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if v != "" {
			return v
		}
	}
	return ""
}

// Library holds the folder currently being served; the UI can switch it at runtime.
type Library struct {
	mu   sync.RWMutex
	root string
	cfg  *Config
}

func NewLibrary(root string, cfg *Config) *Library {
	return &Library{root: root, cfg: cfg}
}

func (l *Library) Root() string {
	l.mu.RLock()
	defer l.mu.RUnlock()
	return l.root
}

// Recent returns recently used folders other than the current one.
func (l *Library) Recent() []string {
	l.mu.RLock()
	defer l.mu.RUnlock()
	out := []string{}
	for _, r := range l.cfg.Recent {
		if r != l.root {
			out = append(out, r)
		}
	}
	return out
}

// SetRoot switches the served folder and remembers it for next time.
func (l *Library) SetRoot(dir string) error {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.root = dir
	l.cfg.Root = dir
	recent := []string{dir}
	for _, r := range l.cfg.Recent {
		if r != dir && len(recent) < maxRecent {
			recent = append(recent, r)
		}
	}
	l.cfg.Recent = recent
	return l.cfg.save()
}
