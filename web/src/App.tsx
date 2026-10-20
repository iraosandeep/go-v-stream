import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FolderPicker, type RootInfo } from "@/components/tui/FolderPicker";
import { Help } from "@/components/tui/Help";
import { KeyHints, type Hint } from "@/components/tui/KeyHints";
import { PanelTitle } from "@/components/tui/PanelTitle";
import { Progress } from "@/components/tui/Progress";
import {
  SETTING_ROWS,
  Settings,
  type SettingRow,
} from "@/components/tui/Settings";
import { Spectrum } from "@/components/tui/Spectrum";
import {
  EQ_PRESETS,
  SPEEDS,
  VOL_MAX,
  VOL_MIN,
  VOL_STEP,
  usePlayer,
  type Repeat,
  type Status,
} from "@/hooks/usePlayer";
import { formatSize, formatTime, streamUrl } from "@/lib/format";
import "./index.css";

type Entry = {
  name: string;
  path: string;
  type: "dir" | "video" | "file";
  size: number | null;
  modified: number;
};

type Listing = { root: string; path: string; entries: Entry[] };

type Focus = "browser" | "settings";

/** A list row: either the `..` parent link or a real entry. */
type Row = { kind: "up" } | { kind: "entry"; entry: Entry; n: number };

const STATUS: Record<
  Status,
  { icon: string; label: string; className: string }
> = {
  stopped: { icon: "■", label: "Stopped", className: "" },
  streaming: { icon: "●", label: "Streaming", className: "text-tui-green" },
  paused: { icon: "❚❚", label: "Paused", className: "text-tui-yellow" },
  buffering: { icon: "◌", label: "Buffering", className: "text-tui-yellow" },
  error: {
    icon: "✕",
    label: "Can't play this file",
    className: "text-tui-red",
  },
};

const REPEATS: Repeat[] = ["off", "all", "one"];
const parentOf = (p: string) => p.split("/").slice(0, -1).join("/");
const cycle = (i: number, dir: number, n: number) => (i + dir + n) % n;

export function App() {
  const [dir, setDir] = useState("");
  const [listing, setListing] = useState<Listing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState("");
  const [filtering, setFiltering] = useState(false);
  const [cursor, setCursor] = useState(0);
  const [focus, setFocus] = useState<Focus>("browser");
  const [settingsRow, setSettingsRow] = useState(0);
  const [helpOpen, setHelpOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [rootInfo, setRootInfo] = useState<RootInfo | null>(null);
  // Bumped when the media folder changes so the listing reloads even if `dir` is already "".
  const [rootVersion, setRootVersion] = useState(0);
  // One-line message about something that changed under us (folder removed, root switched elsewhere).
  const [notice, setNotice] = useState<string | null>(null);
  // Root the current listing/queue belong to; a different root in a response means it was switched
  // from another tab or the server restarted with another folder.
  const knownRoot = useRef<string | null>(null);

  const [current, setCurrent] = useState<Entry | null>(null);
  const [queue, setQueue] = useState<Entry[]>([]);
  const [shuffle, setShuffle] = useState(false);
  const [repeat, setRepeat] = useState<Repeat>("off");

  // Name to put the cursor on once the next listing loads (the folder we just left).
  const selectAfterLoad = useRef<string | null>(null);
  const rowRefs = useRef<(HTMLLIElement | null)[]>([]);
  const screenRef = useRef<HTMLDivElement>(null);

  const playEntry = useRef<(e: Entry, q?: Entry[]) => void>(() => {});
  const advance = useRef<(dir: 1 | -1, auto?: boolean) => void>(() => {});

  const player = usePlayer({ onEnded: () => advance.current(1, true) });

  useEffect(() => {
    fetch("/api/root")
      .then((res) => res.json())
      .then(setRootInfo)
      .catch(() => {});
  }, []);

  const openPicker = () => rootInfo?.canChange && setPickerOpen(true);

  const onRootChosen = (info: RootInfo) => {
    player.stop();
    setCurrent(null);
    setQueue([]);
    setRootInfo(info);
    setNotice(null);
    knownRoot.current = info.root;
    setDir("");
    setRootVersion((v) => v + 1);
    setPickerOpen(false);
  };

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(`/api/files?path=${encodeURIComponent(dir)}`)
      .then(async (res) => {
        const data = await res.json();
        if (!res.ok)
          throw Object.assign(new Error(data.error ?? "Failed to load folder"), { status: res.status });
        return data as Listing;
      })
      .then((data) => {
        if (cancelled) return;
        if (knownRoot.current && knownRoot.current !== data.root) {
          // Paths in the queue belong to the old folder.
          player.stop();
          setCurrent(null);
          setQueue([]);
          setNotice(`Now serving ${data.root}`);
          fetch("/api/root")
            .then((res) => res.json())
            .then(setRootInfo)
            .catch(() => {});
        }
        knownRoot.current = data.root;
        setListing(data);
        const name = selectAfterLoad.current;
        selectAfterLoad.current = null;
        const idx = name ? data.entries.findIndex((e) => e.name === name) : -1;
        // Offset by the `..` row in subfolders; default to the first real entry.
        const offset = dir ? 1 : 0;
        setCursor(idx >= 0 ? idx + offset : data.entries.length ? offset : 0);
      })
      .catch((err) => {
        if (cancelled) return;
        // The folder we were in is gone (deleted, drive unplugged, root switched): go back to the top.
        if (err.status === 404 && dir) {
          setNotice(`"${dir}" no longer exists`);
          setDir("");
          return;
        }
        setListing(null);
        setError(err.message);
      })
      .finally(() => !cancelled && setLoading(false));
    setQuery("");
    setFiltering(false);
    return () => {
      cancelled = true;
    };
  }, [dir, rootVersion]);

  const entries = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (listing?.entries ?? []).filter(
      (e) => !q || e.name.toLowerCase().includes(q),
    );
  }, [listing, query]);

  const rows = useMemo<Row[]>(
    () => [
      ...(dir ? [{ kind: "up" } as Row] : []),
      ...entries.map((entry, i) => ({ kind: "entry", entry, n: i + 1 }) as Row),
    ],
    [dir, entries],
  );

  useEffect(() => {
    setCursor((c) => Math.min(c, Math.max(0, rows.length - 1)));
  }, [rows.length]);

  useEffect(() => {
    rowRefs.current[cursor]?.scrollIntoView({ block: "nearest" });
  }, [cursor, rows]);

  const rootName =
    (rootInfo?.root ?? listing?.root)?.split(/[\\/]/).filter(Boolean).pop() ?? "Library";
  const location = [rootName, ...(dir ? dir.split("/") : [])].join(" / ");

  playEntry.current = (entry, q) => {
    if (q) setQueue(q);
    setCurrent(entry);
    player.load(streamUrl(entry.path), entry.size ?? 0);
  };

  advance.current = (step, auto = false) => {
    if (!current || queue.length === 0) return;
    if (auto && repeat === "one") return player.replay();
    const i = queue.findIndex((e) => e.path === current.path);
    let next: number;
    if (shuffle && queue.length > 1) {
      do next = Math.floor(Math.random() * queue.length);
      while (next === i);
    } else {
      next = i + step;
      if (next < 0 || next >= queue.length) {
        if (auto && repeat === "off") return;
        next = (next + queue.length) % queue.length;
      }
    }
    playEntry.current(queue[next]!);
  };

  const goUp = useCallback(() => {
    if (!dir) return;
    setNotice(null);
    selectAfterLoad.current = dir.split("/").pop() ?? null;
    setDir(parentOf(dir));
  }, [dir]);

  const activate = (row: Row | undefined) => {
    if (!row) return;
    setNotice(null);
    if (row.kind === "up") return goUp();
    const { entry } = row;
    if (entry.type === "dir") setDir(entry.path);
    else if (entry.type === "video")
      playEntry.current(
        entry,
        (listing?.entries ?? []).filter((e) => e.type === "video"),
      );
    else window.open(streamUrl(entry.path), "_blank");
  };

  const changeSetting = (row: SettingRow, step: number) => {
    switch (row) {
      case "VOL":
        player.setVolumeDb((v) =>
          Math.max(VOL_MIN, Math.min(VOL_MAX, v + step * VOL_STEP)),
        );
        break;
      case "EQ":
        player.setEq((e) => cycle(e, step, EQ_PRESETS.length));
        break;
      case "SHF":
        setShuffle((s) => !s);
        break;
      case "RPT":
        setRepeat(
          (r) => REPEATS[cycle(REPEATS.indexOf(r), step, REPEATS.length)]!,
        );
        break;
      case "SPD":
        player.setSpeed((s) =>
          Math.max(0, Math.min(SPEEDS.length - 1, s + step)),
        );
        break;
      case "SRC":
        openPicker();
        break;
    }
  };

  const lastVolume = useRef(0);
  const toggleMute = () =>
    player.setVolumeDb((v) => {
      if (v > VOL_MIN) {
        lastVolume.current = v;
        return VOL_MIN;
      }
      return lastVolume.current;
    });

  const toggleFullscreen = () => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void player.videoRef.current?.parentElement?.requestFullscreen();
  };

  const toggleFocus = () =>
    setFocus((f) => (f === "browser" ? "settings" : "browser"));

  // Keyboard driven, like the terminal app it mimics. Kept in a ref so the listener sees fresh state.
  const onKey = useRef<(e: KeyboardEvent) => void>(() => {});
  onKey.current = (e) => {
    // The folder picker handles its own keys.
    if (pickerOpen) return;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === "k") {
      e.preventDefault();
      setHelpOpen((o) => !o);
      return;
    }
    if (helpOpen) {
      if (e.key === "Escape") setHelpOpen(false);
      return;
    }
    if (mod || e.altKey) return;

    if (filtering) {
      if (e.key === "Escape") {
        setQuery("");
        setFiltering(false);
      } else if (e.key === "Enter") {
        setFiltering(false);
      } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        setCursor((c) =>
          Math.max(
            0,
            Math.min(rows.length - 1, c + (e.key === "ArrowDown" ? 1 : -1)),
          ),
        );
      }
      return;
    }

    const page = 10;
    const move = (d: number) => {
      e.preventDefault();
      if (focus === "browser")
        setCursor((c) => Math.max(0, Math.min(rows.length - 1, c + d)));
      else
        setSettingsRow((r) =>
          Math.max(0, Math.min(SETTING_ROWS.length - 1, r + d)),
        );
    };

    switch (e.key) {
      case "Tab":
        e.preventDefault();
        toggleFocus();
        return;
      case "ArrowDown":
      case "j":
        return move(1);
      case "ArrowUp":
      case "k":
        return move(-1);
      case "PageDown":
        return move(page);
      case "PageUp":
        return move(-page);
      case "g":
      case "Home":
        return move(-rows.length);
      case "G":
      case "End":
        return move(rows.length);
      case "ArrowLeft":
      case "ArrowRight": {
        e.preventDefault();
        const d = e.key === "ArrowRight" ? 1 : -1;
        if (focus === "settings") changeSetting(SETTING_ROWS[settingsRow]!, d);
        else player.seekBy(d * (e.shiftKey ? 30 : 5));
        return;
      }
      case "Enter":
        e.preventDefault();
        if (focus === "settings") changeSetting(SETTING_ROWS[settingsRow]!, 1);
        else activate(rows[cursor]);
        return;
      case "Escape":
      case "Backspace":
        e.preventDefault();
        if (query) setQuery("");
        else if (focus === "settings") setFocus("browser");
        else goUp();
        return;
      case " ":
        e.preventDefault();
        player.toggle();
        return;
      case "/":
        e.preventDefault();
        setFocus("browser");
        setFiltering(true);
        return;
      case "n":
        return advance.current(1);
      case "p":
        return advance.current(-1);
      case "f":
        return toggleFullscreen();
      case "m":
        return toggleMute();
      case "+":
      case "=":
        return changeSetting("VOL", 1);
      case "-":
      case "_":
        return changeSetting("VOL", -1);
      case "]":
        return changeSetting("SPD", 1);
      case "[":
        return changeSetting("SPD", -1);
      case "e":
        return changeSetting("EQ", 1);
      case "s":
        return changeSetting("SHF", 1);
      case "r":
        return changeSetting("RPT", 1);
      case "o":
        e.preventDefault();
        return openPicker();
    }
  };

  useEffect(() => {
    const handler = (e: KeyboardEvent) => onKey.current(e);
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  const status = STATUS[player.status];
  const queueIdx = current
    ? queue.findIndex((e) => e.path === current.path)
    : -1;

  const hints: Hint[] =
    focus === "browser"
      ? [
          { keys: "Esc", label: "Back", action: goUp },
          {
            keys: "Enter",
            label: "Open",
            action: () => activate(rows[cursor]),
          },
          { keys: "Space", label: "Play / Pause", action: player.toggle },
          { keys: "←/→", label: "Seek", action: () => player.seekBy(5) },
          {
            keys: "n/p",
            label: "Next / Prev",
            action: () => advance.current(1),
          },
          { keys: "/", label: "Filter", action: () => setFiltering(true) },
          { keys: "f", label: "Fullscreen", action: toggleFullscreen },
          ...(rootInfo?.canChange
            ? [{ keys: "o", label: "Open folder", action: openPicker }]
            : []),
          { keys: "Tab/Shift+Tab", label: "Focus", action: toggleFocus },
          { keys: "Ctrl+K", label: "Help", action: () => setHelpOpen(true) },
        ]
      : [
          {
            keys: "Esc",
            label: "Back to browser",
            action: () => setFocus("browser"),
          },
          {
            keys: "↑/↓",
            label: "Select",
            action: () =>
              setSettingsRow((r) => cycle(r, 1, SETTING_ROWS.length)),
          },
          {
            keys: "←/→",
            label: "Change",
            action: () => changeSetting(SETTING_ROWS[settingsRow]!, 1),
          },
          { keys: "Space", label: "Play / Pause", action: player.toggle },
          { keys: "Tab/Shift+Tab", label: "Focus", action: toggleFocus },
          { keys: "Ctrl+K", label: "Help", action: () => setHelpOpen(true) },
        ];

  return (
    <div
      ref={screenRef}
      className="flex min-h-dvh flex-col gap-1 px-4 py-4 sm:px-9 sm:py-6 md:h-dvh md:overflow-hidden"
    >
      {/* Header */}
      <header className="shrink-0">
        <div className="flex justify-between gap-4">
          <span className="tracking-[0.5em] text-tui-green">VSTREAM</span>
          <span>[{focus === "browser" ? "Browser" : "Settings"}]</span>
        </div>
        <div className="truncate text-tui-yellow">
          ♫{" "}
          {current
            ? `${current.name} · ${formatSize(current.size)}`
            : "No video loaded"}
        </div>
        <div className="flex justify-between gap-4">
          <span>
            {formatTime(player.time)} /{" "}
            {current && player.duration ? formatTime(player.duration) : "00:00"}
          </span>
          <button
            onClick={player.toggle}
            tabIndex={-1}
            className={status.className}
          >
            {status.icon} {status.label}
          </button>
        </div>
      </header>

      {/* Video — always mounted so the Web Audio graph stays attached to the same element */}
      <div
        className={
          current
            ? "flex h-[35vh] shrink-0 items-center justify-center bg-black md:h-auto md:min-h-0 md:shrink md:flex-[1.4]"
            : "hidden"
        }
      >
        <video
          {...player.videoProps}
          className="max-h-full max-w-full"
          onClick={player.toggle}
          onDoubleClick={toggleFullscreen}
        />
      </div>

      {current && (
        <div className="h-18 shrink-0 pt-2">
          <Spectrum
            analyser={player.analyser}
            sampleRate={player.sampleRate}
            active={player.status === "streaming"}
          />
        </div>
      )}

      <div className="shrink-0">
        <Progress
          time={player.time}
          duration={player.duration}
          buffered={player.buffered}
          loaded={!!current}
          onSeek={player.seek}
        />
      </div>

      {/* Browser + Settings */}
      <div className="flex min-h-0 flex-1 flex-col gap-4 md:flex-row md:gap-10">
        <section
          className="flex min-h-[45vh] min-w-0 flex-1 flex-col md:min-h-0"
          onClick={() => setFocus("browser")}
        >
          <PanelTitle
            title={location}
            focused={focus === "browser"}
            extra={
              rows.length > 0 ? `[${cursor + 1}/${rows.length}]` : undefined
            }
          />
          {(filtering || query) && (
            <div className="flex gap-1 pl-4">
              <span className="text-tui-yellow">/</span>
              {filtering ? (
                <input
                  autoFocus
                  value={query}
                  onChange={(e) => {
                    setQuery(e.target.value);
                    setCursor(dir ? 1 : 0);
                  }}
                  onBlur={() => setFiltering(false)}
                  className="flex-1 bg-transparent caret-tui-yellow outline-none"
                  spellCheck={false}
                />
              ) : (
                <span>
                  {query}{" "}
                  <span className="text-tui-dim">
                    ({entries.length} match{entries.length === 1 ? "" : "es"})
                  </span>
                </span>
              )}
            </div>
          )}
          <ul className="min-h-0 flex-1 overflow-y-auto">
            {loading && <li className="pl-4 text-tui-dim">Loading…</li>}
            {notice && <li className="pl-4 text-tui-yellow">! {notice}</li>}
            {error && <li className="pl-4 text-tui-red">✕ {error}</li>}
            {!loading && !error && rows.length === 0 && (
              <li className="pl-4 text-tui-dim">No files here</li>
            )}
            {!loading &&
              rows.map((row, i) => {
                const selected = i === cursor;
                const playing =
                  row.kind === "entry" && current?.path === row.entry.path;
                const width = String(entries.length).length;
                return (
                  <li
                    key={row.kind === "up" ? ".." : row.entry.path}
                    ref={(el) => {
                      rowRefs.current[i] = el;
                    }}
                    onClick={() => {
                      setCursor(i);
                      activate(row);
                    }}
                    className={`flex cursor-pointer gap-2 whitespace-pre hover:bg-tui-badge/40 ${
                      selected
                        ? "font-bold text-tui-yellow"
                        : playing
                          ? "text-tui-green"
                          : ""
                    }`}
                  >
                    <span className="w-6 shrink-0 text-tui-yellow">
                      {selected ? ">" : " "}
                      {playing ? "▶" : " "}
                    </span>
                    {row.kind === "up" ? (
                      <span>{" ".repeat(width + 2)}../</span>
                    ) : (
                      <>
                        <span
                          className="shrink-0 text-right"
                          style={{ width: `${width + 1}ch` }}
                        >
                          {row.n}.
                        </span>
                        <span className="truncate">
                          <span
                            className={
                              selected || playing
                                ? ""
                                : row.entry.type === "dir"
                                  ? "text-tui-blue"
                                  : row.entry.type === "file"
                                    ? "text-tui-dim"
                                    : ""
                            }
                          >
                            {row.entry.name}
                            {row.entry.type === "dir" ? "/" : ""}
                          </span>
                          {row.entry.type !== "dir" && (
                            <span className={selected ? "" : "text-tui-dim"}>
                              {" "}
                              · {formatSize(row.entry.size)}
                            </span>
                          )}
                        </span>
                      </>
                    )}
                  </li>
                );
              })}
          </ul>
        </section>

        <aside
          className="shrink-0 md:w-75"
          onClick={() => setFocus("settings")}
        >
          <Settings
            focused={focus === "settings"}
            row={settingsRow}
            source={rootName}
            queuePos={queueIdx >= 0 ? `${queueIdx + 1}/${queue.length}` : null}
            volumeDb={player.volumeDb}
            eq={player.eq}
            shuffle={shuffle}
            repeat={repeat}
            speed={player.speed}
            net={player.net}
            onChange={(row, step) => {
              setSettingsRow(SETTING_ROWS.indexOf(row));
              changeSetting(row, step);
            }}
          />
        </aside>
      </div>

      <footer className="shrink-0 pt-1">
        <KeyHints hints={hints} />
      </footer>

      {helpOpen && <Help onClose={() => setHelpOpen(false)} />}
      {pickerOpen && rootInfo && (
        <FolderPicker
          info={rootInfo}
          onClose={() => setPickerOpen(false)}
          onChosen={onRootChosen}
        />
      )}
    </div>
  );
}

export default App;
