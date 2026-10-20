package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// newTestServer builds a media folder with a video, a text file, a nested season folder, a
// hidden Windows folder and a symlink escaping the root.
func newTestServer(t *testing.T) (*Server, string, []byte) {
	t.Helper()
	t.Setenv("HOME", t.TempDir()) // keep config writes out of the real home directory
	base, _ := filepath.EvalSymlinks(t.TempDir())
	root := filepath.Join(base, "media")
	video := bytes.Repeat([]byte("0123456789abcdef"), 400_000) // 6.4 MB
	must(t, os.MkdirAll(filepath.Join(root, "Shows", "Season 1"), 0o755))
	must(t, os.MkdirAll(filepath.Join(root, "$RECYCLE.BIN"), 0o755))
	must(t, os.WriteFile(filepath.Join(root, "movie.mp4"), video, 0o644))
	must(t, os.WriteFile(filepath.Join(root, "notes.txt"), []byte("hi"), 0o644))
	for _, ep := range []string{"Episode 10.mkv", "Episode 2.mkv", "episode 1.mkv"} {
		must(t, os.WriteFile(filepath.Join(root, "Shows", "Season 1", ep), []byte("x"), 0o644))
	}
	must(t, os.WriteFile(filepath.Join(base, "secret.txt"), []byte("secret"), 0o644))
	must(t, os.Symlink(base, filepath.Join(root, "escape")))
	return NewServer(NewLibrary(root, &Config{})), root, video
}

func must(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatal(err)
	}
}

// do sends a request as if from the browser on this machine, unless remote is set.
func do(s *Server, method, target, body string, headers map[string]string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, "http://localhost:7171"+target, strings.NewReader(body))
	req.RemoteAddr = "127.0.0.1:50000"
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	rec := httptest.NewRecorder()
	s.ServeHTTP(rec, req)
	return rec
}

func TestStreamRanges(t *testing.T) {
	s, _, video := newTestServer(t)
	cases := []struct {
		rng        string
		status     int
		start, end int
	}{
		{"bytes=0-", 206, 0, chunkSize - 1}, // open-ended: capped to one chunk
		{"bytes=100-199", 206, 100, 199},    // exact range untouched
		{fmt.Sprintf("bytes=%d-", len(video)-500), 206, len(video) - 500, len(video) - 1},
		{"bytes=-1000", 206, len(video) - 1000, len(video) - 1}, // suffix
		{"bytes=0-99999999", 206, 0, chunkSize - 1},             // oversized: capped
	}
	for _, c := range cases {
		rec := do(s, "GET", "/api/stream?path=movie.mp4", "", map[string]string{"Range": c.rng})
		if rec.Code != c.status {
			t.Fatalf("%s: status %d", c.rng, rec.Code)
		}
		want := fmt.Sprintf("bytes %d-%d/%d", c.start, c.end, len(video))
		if got := rec.Header().Get("Content-Range"); got != want {
			t.Errorf("%s: Content-Range %q, want %q", c.rng, got, want)
		}
		if !bytes.Equal(rec.Body.Bytes(), video[c.start:c.end+1]) {
			t.Errorf("%s: body mismatch", c.rng)
		}
		if ct := rec.Header().Get("Content-Type"); ct != "video/mp4" {
			t.Errorf("%s: Content-Type %q", c.rng, ct)
		}
	}

	rec := do(s, "GET", "/api/stream?path=movie.mp4", "", map[string]string{"Range": fmt.Sprintf("bytes=%d-", len(video)+10)})
	if rec.Code != http.StatusRequestedRangeNotSatisfiable {
		t.Errorf("out of range: status %d", rec.Code)
	}
	rec = do(s, "GET", "/api/stream?path=movie.mp4", "", nil)
	if rec.Code != 200 || rec.Body.Len() != len(video) || rec.Header().Get("Accept-Ranges") != "bytes" {
		t.Errorf("no range: status %d, %d bytes, Accept-Ranges %q", rec.Code, rec.Body.Len(), rec.Header().Get("Accept-Ranges"))
	}
}

func TestStreamRejectsEscapes(t *testing.T) {
	s, _, _ := newTestServer(t)
	for _, p := range []string{"../secret.txt", "..%2Fsecret.txt", "escape/secret.txt", "/etc/passwd", "Shows/../../secret.txt"} {
		rec := do(s, "GET", "/api/stream?path="+p, "", nil)
		if rec.Code == 200 {
			t.Errorf("%s: served %q", p, rec.Body.String())
		}
	}
	// Absolute-looking paths are treated as relative to the root, not the filesystem.
	if rec := do(s, "GET", "/api/stream?path=/movie.mp4", "", map[string]string{"Range": "bytes=0-1"}); rec.Code != 206 {
		t.Errorf("leading slash: status %d", rec.Code)
	}
}

func TestListing(t *testing.T) {
	s, _, _ := newTestServer(t)
	var l Listing
	rec := do(s, "GET", "/api/files", "", nil)
	must(t, json.Unmarshal(rec.Body.Bytes(), &l))
	var names []string
	for _, e := range l.Entries {
		names = append(names, e.Name+":"+e.Type)
	}
	if got, want := strings.Join(names, ","), "Shows:dir,movie.mp4:video,notes.txt:file"; got != want {
		t.Errorf("root listing %q, want %q (hidden + escaping symlink must be omitted)", got, want)
	}

	rec = do(s, "GET", "/api/files?path=Shows/Season%201", "", nil)
	must(t, json.Unmarshal(rec.Body.Bytes(), &l))
	names = nil
	for _, e := range l.Entries {
		names = append(names, e.Path)
	}
	if got, want := strings.Join(names, ","), "Shows/Season 1/episode 1.mkv,Shows/Season 1/Episode 2.mkv,Shows/Season 1/Episode 10.mkv"; got != want {
		t.Errorf("natural sort %q, want %q", got, want)
	}

	if rec := do(s, "GET", "/api/files?path=gone", "", nil); rec.Code != 404 || !strings.Contains(rec.Body.String(), "Folder not found") {
		t.Errorf("missing folder: %d %s", rec.Code, rec.Body.String())
	}
	// ".." can't climb above the root: it is pinned there.
	must(t, json.Unmarshal(do(s, "GET", "/api/files?path=../..", "", nil).Body.Bytes(), &l))
	if l.Path != "" || len(l.Entries) != 3 {
		t.Errorf("parent of root escaped: %+v", l)
	}
}

func TestFolderSwitchingIsLocalOnly(t *testing.T) {
	s, root, _ := newTestServer(t)
	target := filepath.Join(root, "Shows")
	body := fmt.Sprintf(`{"path":%q}`, target)

	remote := []map[string]string{
		{"X-Forwarded-For": "1.2.3.4"},  // ngrok / Tailscale Funnel
		{"Cf-Connecting-Ip": "1.2.3.4"}, // cloudflared
	}
	for _, h := range remote {
		if rec := do(s, "POST", "/api/root", body, h); rec.Code != 403 {
			t.Errorf("%v: POST /api/root status %d", h, rec.Code)
		}
		if rec := do(s, "GET", "/api/browse?path=/", "", h); rec.Code != 403 {
			t.Errorf("%v: browse status %d", h, rec.Code)
		}
		var info rootInfo
		must(t, json.Unmarshal(do(s, "GET", "/api/root", "", h).Body.Bytes(), &info))
		if info.CanChange || info.Home != nil || len(info.Volumes) > 0 {
			t.Errorf("%v: remote root info leaks %+v", h, info)
		}
	}

	// A non-loopback client (another device on the LAN) is also refused.
	req := httptest.NewRequest("POST", "http://192.168.1.5:7171/api/root", strings.NewReader(body))
	req.RemoteAddr = "192.168.1.9:4000"
	rec := httptest.NewRecorder()
	s.ServeHTTP(rec, req)
	if rec.Code != 403 {
		t.Errorf("LAN client: status %d", rec.Code)
	}

	// Local: switch, then the listing reflects the new root and the choice is saved.
	rec = do(s, "POST", "/api/root", body, nil)
	if rec.Code != 200 {
		t.Fatalf("local switch: %d %s", rec.Code, rec.Body.String())
	}
	var l Listing
	must(t, json.Unmarshal(do(s, "GET", "/api/files", "", nil).Body.Bytes(), &l))
	if l.Root != target || len(l.Entries) != 1 || l.Entries[0].Name != "Season 1" {
		t.Errorf("after switch: %+v", l)
	}
	if cfg := loadConfig(); cfg.Root != target || cfg.Recent[0] != target {
		t.Errorf("config not saved: %+v", cfg)
	}

	if rec := do(s, "POST", "/api/root", `{"path":"/definitely/not/here"}`, nil); rec.Code != 400 {
		t.Errorf("bad folder: status %d", rec.Code)
	}
}

func TestBrowse(t *testing.T) {
	s, root, _ := newTestServer(t)
	var b struct {
		Path   string   `json:"path"`
		Parent *string  `json:"parent"`
		Dirs   []string `json:"dirs"`
	}
	must(t, json.Unmarshal(do(s, "GET", "/api/browse?path="+root, "", nil).Body.Bytes(), &b))
	if strings.Join(b.Dirs, ",") != "escape,Shows" || b.Parent == nil || *b.Parent != filepath.Dir(root) {
		t.Errorf("browse: %+v", b)
	}
}

func TestStaticFallback(t *testing.T) {
	s, _, _ := newTestServer(t)
	for _, p := range []string{"/", "/some/deep/route"} {
		rec := do(s, "GET", p, "", nil)
		if rec.Code != 200 || !strings.Contains(rec.Body.String(), `<div id="root">`) {
			t.Errorf("%s: %d", p, rec.Code)
		}
	}
	idx, _ := io.ReadAll(do(s, "GET", "/", "", nil).Body)
	start := bytes.Index(idx, []byte(`src="/`))
	if start < 0 {
		t.Fatal("no script tag in index.html")
	}
	src := string(idx[start+5 : start+5+bytes.IndexByte(idx[start+5:], '"')])
	rec := do(s, "GET", src, "", nil)
	if rec.Code != 200 || !strings.Contains(rec.Header().Get("Cache-Control"), "immutable") {
		t.Errorf("asset %s: %d %q", src, rec.Code, rec.Header().Get("Cache-Control"))
	}
}

func TestIsLocalHostHeader(t *testing.T) {
	req := httptest.NewRequest("GET", "http://abc.ngrok-free.app/", nil)
	req.RemoteAddr = "127.0.0.1:1"
	if isLocal(req) {
		t.Error("foreign Host header treated as local")
	}
	req = httptest.NewRequest("GET", "http://[::1]:7171/", nil)
	req.RemoteAddr = "[::1]:1"
	if !isLocal(req) {
		t.Error("IPv6 loopback not treated as local")
	}
}

func TestCapRangeAndNaturalSort(t *testing.T) {
	if got := capRange("bytes=10-"); got != fmt.Sprintf("bytes=10-%d", 10+chunkSize-1) {
		t.Errorf("capRange open: %s", got)
	}
	if got := capRange("bytes=0-1,5-9"); got != "bytes=0-1,5-9" {
		t.Errorf("multi-range changed: %s", got)
	}
	if !naturalLess("ep2", "ep10") || naturalLess("ep10", "ep2") || !naturalLess("a", "a1") || !naturalLess("abc", "ABD") {
		t.Error("naturalLess ordering wrong")
	}
}
