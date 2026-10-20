# vstream

Stream videos from any folder on your machine to a browser. A single ~6 MB binary with the UI embedded:
no Node, no runtime, no cloud. Your files stay where they are; vstream serves them in 2 MB chunks over
HTTP range requests, so playback starts immediately and seeking jumps straight to the right bytes.

The UI is terminal-styled (after [cliamp](https://github.com/bjarneo/cliamp)): folder browser, 10-band EQ,
volume boost, spectrum visualiser, shuffle/repeat/speed, and full keyboard control.

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/iraosandeep/go-v-stream/main/install.sh | sh
```

Or build from source (Go 1.25+ and [Bun](https://bun.sh) for the UI bundle):

```bash
make build
install -d ~/.local/bin && install vstream ~/.local/bin/
```

## Use

```bash
vstream ~/Movies                  # stream a folder; opens your browser
vstream /Volumes/PortableSSD      # an external drive
vstream                           # reopen the last folder picked in the UI (else ~/Movies)
vstream -port 8080 -no-open ~/Videos
```

| Flag | Default | |
| --- | --- | --- |
| `-port` | `7171` | Walks forward if taken; `0` picks a free port |
| `-host` | `127.0.0.1` | `0.0.0.0` lets phones/TVs on your Wi-Fi connect |
| `-no-open` | | Don't launch a browser |
| `-dev DIR` | | Serve the UI from `DIR` (e.g. `web/dist`) instead of the embedded copy |
| `-quiet`, `-no-color`, `-version` | | |

### Picking a folder

Press `o` in the UI (or Enter on **SRC**) to browse any folder on the machine, with shortcuts to Home, mounted
drives and recent folders (`1-9`). `Space` streams from the current folder; `f` opens the native macOS
Finder dialog. The choice is saved to `~/.config/v-stream/config.json`.

Changing folders is only allowed from the machine itself (`http://localhost`). Anyone reaching vstream
through a tunnel or your LAN can browse and stream the chosen folder, but can't switch it or see the rest of the disk.

### Watching from elsewhere

vstream binds to localhost, so put a tunnel in front of it:

```bash
ngrok http 7171                                   # quick, temporary URL
cloudflared tunnel --url http://localhost:7171    # Cloudflare, free
tailscale serve 7171                              # private, only your Tailscale devices
```

## Keys

| Keys | Action |
| --- | --- |
| `↑/↓` `j/k` `PgUp/PgDn` `g/G` | Move cursor |
| `Enter` / `Esc` `Backspace` | Open / back to parent folder |
| `/` | Filter current folder |
| `o` | Open another folder (host machine only) |
| `Space` | Play / pause |
| `←/→` (`Shift` = 30s) | Seek 5s |
| `n` / `p` | Next / previous video in folder |
| `f` · `m` · `+/-` · `[ ]` | Fullscreen · mute · volume · speed |
| `e` · `s` · `r` | Cycle EQ preset · shuffle · repeat (off/all/one) |
| `Tab` | Switch focus browser ↔ settings (`↑/↓` select, `←/→` change) |
| `Ctrl+K` | Help |

## Development

```
main.go      flags, startup narration, browser launch, graceful shutdown
server.go    routes, embedded UI, folder picker endpoints
stream.go    range streaming (http.ServeContent, chunk-capped)
media.go     safe path resolution, listings, natural sort
config.go    served folder + saved config
local.go     "is this request from the host machine?"
web/         React UI, bundled by Bun into web/dist (embedded via go:embed)
```

```bash
make dev DIR=~/Movies   # rebuild the UI and run with it served from disk
make test               # go test ./...
make dist               # cross-compile linux/darwin/windows/freebsd into dist/
make publish 0.2.0      # bump VERSION, commit, tag; push the tag to trigger the GitHub release
```

`web/dist` is committed so `go build` works without Bun; run `make web` after changing the UI.

### API

- `GET /api/files?path=<dir>`: list a folder (relative to the served root)
- `GET /api/stream?path=<file>`: stream a file, honouring `Range` / `If-Range`
- `GET /api/root`: the served folder (plus Home, drives and recent folders when local)
- `POST /api/root {path}`, `POST /api/root/pick`, `GET /api/browse?path=<abs>`: localhost only
