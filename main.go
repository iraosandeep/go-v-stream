package main

import (
	"context"
	_ "embed"
	"flag"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"runtime"
	"strings"
	"syscall"
	"time"
)

//go:embed VERSION
var rawVersion string

var version = strings.TrimSpace(rawVersion)

func main() {
	var (
		port         = flag.Int("port", 7171, "port to listen on (0 picks a free one)")
		host         = flag.String("host", "127.0.0.1", "address to bind (0.0.0.0 lets other devices on your network connect)")
		noOpen       = flag.Bool("no-open", false, "do not launch a browser")
		dev          = flag.String("dev", "", "serve the UI from this directory (e.g. web/dist) instead of the embedded copy")
		showVer      = flag.Bool("version", false, "print version and exit")
		showVerShort = flag.Bool("v", false, "print version and exit (shorthand)")
		noColor      = flag.Bool("no-color", false, "disable colour output")
		quiet        = flag.Bool("quiet", false, "suppress narration")
	)
	flag.Usage = func() {
		fmt.Fprintf(os.Stderr, "vstream %s - stream videos from a local folder to your browser\n\nusage: vstream [flags] [folder]\n\n"+
			"With no folder, vstream reopens the last folder picked in the UI, then ~/Movies.\n\nflags:\n", version)
		flag.PrintDefaults()
	}
	flag.Parse()

	if *noColor {
		f := false
		uiForcedColor = &f
	}
	uiQuiet = *quiet

	if *showVer || *showVerShort || (flag.NArg() == 1 && flag.Arg(0) == "version") {
		fmt.Printf("vstream %s (%s/%s)\n", version, runtime.GOOS, runtime.GOARCH)
		return
	}

	if *dev != "" {
		if err := useDiskAssets(*dev); err != nil {
			fatal(fmt.Errorf("-dev %s: %w", *dev, err))
		}
	}

	cfg := loadConfig()
	root, err := resolveRoot(flag.Arg(0), os.Getenv("MEDIA_DIR"), cfg)
	if err != nil {
		fatal(err)
	}

	ln, addr, err := listen(*host, *port)
	if err != nil {
		fatal(err)
	}

	lib := NewLibrary(root, cfg)
	srv := &http.Server{Handler: NewServer(lib), ReadHeaderTimeout: 10 * time.Second}

	url := "http://" + browserAddr(addr)
	uiHeading("vstream "+version, os.Stdout)
	uiKV("media", root, 8, os.Stdout)
	uiKV("url", uiAccent(url, os.Stdout), 8, os.Stdout)
	uiHint(fmt.Sprintf("press o in the UI to pick another folder · share with: ngrok http %s · ctrl-c to stop", portOf(addr)), os.Stdout)

	if !*noOpen {
		go openBrowser(url)
	}

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt, syscall.SIGTERM)
	go func() {
		<-stop
		fmt.Print("\r")
		uiStatus("warn", "stopping", "", os.Stderr)
		go func() {
			<-stop // Second interrupt forces immediate exit
			os.Exit(130)
		}()
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		_ = srv.Shutdown(ctx)
	}()

	if err := srv.Serve(ln); err != nil && err != http.ErrServerClosed {
		fatal(err)
	}
}

// listen binds the requested port, walking forward if it is already taken so a
// second instance does not simply fail.
func listen(host string, port int) (net.Listener, string, error) {
	if port == 0 {
		ln, err := net.Listen("tcp", net.JoinHostPort(host, "0"))
		if err != nil {
			return nil, "", err
		}
		return ln, ln.Addr().String(), nil
	}
	for p := port; p < port+100; p++ {
		if ln, err := net.Listen("tcp", net.JoinHostPort(host, fmt.Sprint(p))); err == nil {
			return ln, ln.Addr().String(), nil
		}
	}
	return nil, "", fmt.Errorf("no free port available starting from %d", port)
}

// browserAddr is the address to open locally: wildcard binds are reachable via localhost,
// which is also what unlocks the folder picker.
func browserAddr(addr string) string {
	return "localhost:" + portOf(addr)
}

func portOf(addr string) string {
	_, port, _ := net.SplitHostPort(addr)
	return port
}

func openBrowser(url string) {
	if b := os.Getenv("BROWSER"); b != "" {
		if exec.Command(b, url).Start() == nil {
			return
		}
	}
	var cmds []*exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		cmds = []*exec.Cmd{exec.Command("open", url)}
	case "windows":
		cmds = []*exec.Cmd{exec.Command("rundll32", "url.dll,FileProtocolHandler", url)}
	default:
		cmds = []*exec.Cmd{exec.Command("xdg-open", url), exec.Command("sensible-browser", url), exec.Command("gio", "open", url)}
	}
	for _, cmd := range cmds {
		if cmd.Start() == nil {
			return
		}
	}
}

func fatal(err error) {
	uiStatus("err", err.Error(), "", os.Stderr)
	os.Exit(1)
}
