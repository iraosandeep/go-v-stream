package main

import (
	"errors"
	"os/exec"
	"strings"
)

const canPickNative = true

var errPickCancelled = errors.New("cancelled")

// pickFolderNative shows the macOS "Choose Folder" dialog on this machine.
func pickFolderNative(start string) (string, error) {
	safe := strings.NewReplacer(`"`, "", `\`, "").Replace(start)
	script := `POSIX path of (choose folder with prompt "Choose a folder to stream" default location POSIX file "` + safe + `")`
	out, err := exec.Command("osascript", "-e", "activate", "-e", script).Output()
	if err != nil {
		return "", errPickCancelled
	}
	return strings.TrimSpace(string(out)), nil
}
