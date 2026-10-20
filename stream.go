package main

import (
	"fmt"
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
)

// chunkSize caps the bytes sent per range response. The browser requests the next chunk as
// playback advances, so a file is streamed piece by piece instead of being downloaded in full.
const chunkSize = 2 << 20

var singleRange = regexp.MustCompile(`^bytes=(\d+)-(\d*)$`)

// capRange rewrites an open-ended or oversized single range ("bytes=0-") to at most chunkSize
// bytes. Suffix and multi-part ranges are left for http.ServeContent to handle as-is.
func capRange(header string) string {
	m := singleRange.FindStringSubmatch(strings.TrimSpace(header))
	if m == nil {
		return header
	}
	start, err := strconv.ParseInt(m[1], 10, 64)
	if err != nil {
		return header
	}
	limit := start + chunkSize - 1
	if m[2] != "" {
		if end, err := strconv.ParseInt(m[2], 10, 64); err == nil && end < limit {
			return header
		}
	}
	return fmt.Sprintf("bytes=%d-%d", start, limit)
}

func contentType(name string) string {
	ext := strings.ToLower(filepath.Ext(name))
	if t, ok := videoTypes[ext]; ok {
		return t
	}
	if t := mime.TypeByExtension(ext); t != "" {
		return t
	}
	return "application/octet-stream"
}

// serveFile streams a file under root, honouring Range (206), If-Range and conditional requests.
func serveFile(w http.ResponseWriter, r *http.Request, root, rel string) {
	full, _, err := resolveSafe(root, rel)
	if err != nil {
		if err == errOutsideRoot {
			http.Error(w, "Invalid path", http.StatusBadRequest)
		} else {
			http.Error(w, "Not found", http.StatusNotFound)
		}
		return
	}
	f, err := os.Open(full)
	if err != nil {
		http.Error(w, "Not found", http.StatusNotFound)
		return
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil || info.IsDir() {
		http.Error(w, "Not found", http.StatusNotFound)
		return
	}

	if rh := r.Header.Get("Range"); rh != "" {
		r.Header.Set("Range", capRange(rh))
	}
	w.Header().Set("Content-Type", contentType(full))
	w.Header().Set("Cache-Control", "no-cache")
	// ServeContent streams from the file handle; nothing is buffered in memory.
	http.ServeContent(w, r, info.Name(), info.ModTime(), f)
}
