package main

import (
	"embed"
	"encoding/json"
	"errors"
	"io/fs"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"runtime"
	"strings"
)

//go:embed all:web/dist
var embedded embed.FS

// assets is the embedded web/dist directory, or the one on disk under -dev.
var assets fs.FS = mustSub(embedded, "web/dist")

func mustSub(f fs.FS, dir string) fs.FS {
	sub, err := fs.Sub(f, dir)
	if err != nil {
		panic(err)
	}
	return sub
}

// useDiskAssets serves the UI from a built directory on disk so it can be rebuilt without
// recompiling the binary. Development convenience only.
func useDiskAssets(dir string) error {
	if _, err := os.Stat(filepath.Join(dir, "index.html")); err != nil {
		return err
	}
	assets = os.DirFS(dir)
	return nil
}

type Server struct {
	lib *Library
	mux *http.ServeMux
}

func NewServer(lib *Library) *Server {
	s := &Server{lib: lib, mux: http.NewServeMux()}
	s.mux.HandleFunc("GET /api/root", s.handleRootInfo)
	s.mux.HandleFunc("POST /api/root", s.localOnly(s.handleSetRoot))
	s.mux.HandleFunc("POST /api/root/pick", s.localOnly(s.handlePick))
	s.mux.HandleFunc("GET /api/browse", s.localOnly(s.handleBrowse))
	s.mux.HandleFunc("GET /api/files", s.handleFiles)
	s.mux.HandleFunc("GET /api/stream", s.handleStream)
	s.mux.HandleFunc("GET /", s.handleStatic)
	return s
}

func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) { s.mux.ServeHTTP(w, r) }

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}

// fsError turns a filesystem error into a friendly message and status code.
func fsError(w http.ResponseWriter, err error, what string) {
	switch {
	case errors.Is(err, errOutsideRoot):
		writeError(w, http.StatusBadRequest, "Invalid path")
	case errors.Is(err, fs.ErrNotExist):
		writeError(w, http.StatusNotFound, what+" not found")
	case errors.Is(err, fs.ErrPermission):
		msg := "Permission denied"
		if runtime.GOOS == "darwin" {
			msg += ": allow your terminal in System Settings › Privacy & Security › Files and Folders"
		}
		writeError(w, http.StatusForbidden, msg)
	default:
		writeError(w, http.StatusInternalServerError, err.Error())
	}
}

func (s *Server) localOnly(h http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !isLocal(r) {
			writeError(w, http.StatusForbidden, "The folder can only be changed on the host machine")
			return
		}
		h(w, r)
	}
}

type rootInfo struct {
	Root          string   `json:"root"`
	CanChange     bool     `json:"canChange"`
	CanPickNative bool     `json:"canPickNative"`
	Home          *string  `json:"home"`
	Volumes       []string `json:"volumes"`
	Recent        []string `json:"recent"`
	Cancelled     bool     `json:"cancelled,omitempty"`
}

func (s *Server) rootInfo(r *http.Request) rootInfo {
	info := rootInfo{Root: s.lib.Root(), Volumes: []string{}, Recent: []string{}}
	if !isLocal(r) {
		return info
	}
	home, _ := os.UserHomeDir()
	info.CanChange = true
	info.CanPickNative = canPickNative
	info.Home = &home
	info.Volumes = volumes(home)
	info.Recent = s.lib.Recent()
	return info
}

// volumes lists mounted drives worth offering as shortcuts in the folder picker.
func volumes(home string) []string {
	var parents []string
	switch runtime.GOOS {
	case "darwin":
		parents = []string{"/Volumes"}
	case "linux":
		user := filepath.Base(home)
		parents = []string{"/media/" + user, "/run/media/" + user, "/mnt"}
	}
	out := []string{}
	for _, p := range parents {
		names, err := subdirs(p)
		if err != nil {
			continue
		}
		for _, n := range names {
			if n != "Recovery" {
				out = append(out, filepath.Join(p, n))
			}
		}
	}
	return out
}

func (s *Server) handleRootInfo(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, s.rootInfo(r))
}

func (s *Server) switchRoot(w http.ResponseWriter, r *http.Request, dir string) {
	if err := s.lib.SetRoot(dir); err != nil {
		uiStatus("warn", "could not save config", err.Error(), os.Stderr)
	}
	uiStatus("ok", "now serving", dir, os.Stdout)
	writeJSON(w, http.StatusOK, s.rootInfo(r))
}

func (s *Server) handleSetRoot(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Path string `json:"path"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.Path == "" {
		writeError(w, http.StatusBadRequest, "Missing path")
		return
	}
	dir, err := canonicalDir(body.Path)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	s.switchRoot(w, r, dir)
}

func (s *Server) handlePick(w http.ResponseWriter, r *http.Request) {
	picked, err := pickFolderNative(s.lib.Root())
	if errors.Is(err, errPickCancelled) {
		info := s.rootInfo(r)
		info.Cancelled = true
		writeJSON(w, http.StatusOK, info)
		return
	}
	if err != nil {
		writeError(w, http.StatusNotImplemented, err.Error())
		return
	}
	dir, err := canonicalDir(picked)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	s.switchRoot(w, r, dir)
}

func (s *Server) handleBrowse(w http.ResponseWriter, r *http.Request) {
	p := r.URL.Query().Get("path")
	if p == "" {
		p = s.lib.Root()
	}
	dir, err := filepath.Abs(expandHome(p))
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	dirs, err := subdirs(dir)
	if err != nil {
		fsError(w, err, "Folder")
		return
	}
	var parent *string
	if up := filepath.Dir(dir); up != dir {
		parent = &up
	}
	writeJSON(w, http.StatusOK, map[string]any{"path": dir, "parent": parent, "dirs": dirs})
}

func (s *Server) handleFiles(w http.ResponseWriter, r *http.Request) {
	listing, err := listDir(s.lib.Root(), r.URL.Query().Get("path"))
	if err != nil {
		fsError(w, err, "Folder")
		return
	}
	writeJSON(w, http.StatusOK, listing)
}

func (s *Server) handleStream(w http.ResponseWriter, r *http.Request) {
	serveFile(w, r, s.lib.Root(), r.URL.Query().Get("path"))
}

// handleStatic serves the embedded UI; unknown paths fall back to index.html.
func (s *Server) handleStatic(w http.ResponseWriter, r *http.Request) {
	name := strings.TrimPrefix(path.Clean(r.URL.Path), "/")
	if name == "" || name == "index.html" {
		serveIndex(w, r)
		return
	}
	if st, err := fs.Stat(assets, name); err != nil || st.IsDir() {
		serveIndex(w, r)
		return
	}
	// Bundled assets have content hashes in their names, so they never change.
	w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
	http.ServeFileFS(w, r, assets, name)
}

func serveIndex(w http.ResponseWriter, r *http.Request) {
	b, err := fs.ReadFile(assets, "index.html")
	if err != nil {
		http.Error(w, "UI not built: run `make web`", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache")
	_, _ = w.Write(b)
}
