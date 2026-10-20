//go:build !darwin

package main

import "errors"

const canPickNative = false

var errPickCancelled = errors.New("cancelled")

func pickFolderNative(string) (string, error) {
	return "", errors.New("the native folder dialog is only available on macOS")
}
