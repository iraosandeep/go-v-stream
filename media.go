package main

import (
	"errors"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"
	"unicode"
)

// videoTypes maps playable extensions to the MIME type served for them.
var videoTypes = map[string]string{
	".mp4":  "video/mp4",
	".m4v":  "video/mp4",
	".mov":  "video/mp4", // Most .mov files are H.264/AAC; labelling them mp4 lets Chrome/Firefox play them too.
	".webm": "video/webm",
	".mkv":  "video/webm",
	".ogv":  "video/ogg",
	".avi":  "video/x-msvideo",
	".ts":   "video/mp2t",
}

// hiddenNames are Windows system folders that show up on external drives.
var hiddenNames = map[string]bool{"$RECYCLE.BIN": true, "System Volume Information": true}

func isHidden(name string) bool { return strings.HasPrefix(name, ".") || hiddenNames[name] }

type Entry struct {
	Name     string  `json:"name"`
	Path     string  `json:"path"`
	Type     string  `json:"type"` // "dir" | "video" | "file"
	Size     *int64  `json:"size"`
	Modified float64 `json:"modified"` // ms since epoch
}

type Listing struct {
	Root    string  `json:"root"`
	Path    string  `json:"path"`
	Entries []Entry `json:"entries"`
}

var errOutsideRoot = errors.New("invalid path")

// within reports whether p is root or inside it.
func within(root, p string) bool {
	return p == root || strings.HasPrefix(p, root+string(filepath.Separator))
}

// resolveSafe maps a client-supplied, /-separated path relative to root onto the filesystem.
// Cleaning it as an absolute path pins ".." at the root, and resolving symlinks afterwards
// catches links that point outside it. It returns the real path and the normalised relative path.
func resolveSafe(root, rel string) (string, string, error) {
	rel = strings.TrimPrefix(path.Clean("/"+rel), "/")
	full, err := filepath.EvalSymlinks(filepath.Join(root, filepath.FromSlash(rel)))
	if err != nil {
		return "", "", err
	}
	if !within(root, full) {
		return "", "", errOutsideRoot
	}
	return full, rel, nil
}

func listDir(root, rel string) (*Listing, error) {
	dir, rel, err := resolveSafe(root, rel)
	if err != nil {
		return nil, err
	}
	dirents, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	entries := make([]Entry, 0, len(dirents))
	for _, d := range dirents {
		name := d.Name()
		if isHidden(name) {
			continue
		}
		// Follow symlinks, but hide any that point outside the root (they couldn't be opened).
		target, err := filepath.EvalSymlinks(filepath.Join(dir, name))
		if err != nil || !within(root, target) {
			continue
		}
		info, err := os.Stat(target)
		if err != nil {
			continue
		}
		e := Entry{
			Name:     name,
			Path:     path.Join(rel, name),
			Type:     "file",
			Modified: float64(info.ModTime().UnixMilli()),
		}
		if info.IsDir() {
			e.Type = "dir"
		} else {
			size := info.Size()
			e.Size = &size
			if _, ok := videoTypes[strings.ToLower(filepath.Ext(name))]; ok {
				e.Type = "video"
			}
		}
		entries = append(entries, e)
	}
	sort.SliceStable(entries, func(i, j int) bool {
		if di, dj := entries[i].Type == "dir", entries[j].Type == "dir"; di != dj {
			return di
		}
		return naturalLess(entries[i].Name, entries[j].Name)
	})
	return &Listing{Root: root, Path: rel, Entries: entries}, nil
}

// subdirs lists the visible sub-folders of an absolute path, for the folder picker.
func subdirs(dir string) ([]string, error) {
	dirents, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	out := []string{}
	for _, d := range dirents {
		if isHidden(d.Name()) {
			continue
		}
		isDir := d.IsDir()
		if d.Type()&fs.ModeSymlink != 0 {
			st, err := os.Stat(filepath.Join(dir, d.Name()))
			isDir = err == nil && st.IsDir()
		}
		if isDir {
			out = append(out, d.Name())
		}
	}
	sort.Slice(out, func(i, j int) bool { return naturalLess(out[i], out[j]) })
	return out, nil
}

// naturalLess compares case-insensitively, ordering digit runs numerically ("ep2" < "ep10").
func naturalLess(a, b string) bool {
	ar, br := []rune(a), []rune(b)
	i, j := 0, 0
	for i < len(ar) && j < len(br) {
		if unicode.IsDigit(ar[i]) && unicode.IsDigit(br[j]) {
			si, sj := i, j
			for i < len(ar) && unicode.IsDigit(ar[i]) {
				i++
			}
			for j < len(br) && unicode.IsDigit(br[j]) {
				j++
			}
			na := strings.TrimLeft(string(ar[si:i]), "0")
			nb := strings.TrimLeft(string(br[sj:j]), "0")
			if len(na) != len(nb) {
				return len(na) < len(nb)
			}
			if na != nb {
				return na < nb
			}
			continue
		}
		ca, cb := unicode.ToLower(ar[i]), unicode.ToLower(br[j])
		if ca != cb {
			return ca < cb
		}
		i++
		j++
	}
	return len(ar)-i < len(br)-j
}
