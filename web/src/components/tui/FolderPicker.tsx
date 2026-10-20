import { useEffect, useRef, useState } from "react";
import { KeyHints } from "./KeyHints";
import { PanelTitle } from "./PanelTitle";

export type RootInfo = {
  root: string;
  canChange: boolean;
  canPickNative: boolean;
  home: string | null;
  volumes: string[];
  recent: string[];
};

type Browse = { path: string; parent: string | null; dirs: string[] };

type Row = { kind: "use" } | { kind: "up" } | { kind: "dir"; name: string };

const join = (dir: string, name: string) =>
  dir.endsWith("/") ? dir + name : `${dir}/${name}`;
const basename = (p: string) => p.split("/").filter(Boolean).pop() ?? p;

async function post(
  url: string,
  body?: unknown,
): Promise<RootInfo & { cancelled?: boolean }> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? "Request failed");
  return data;
}

/** Browse the host machine's folders and pick one as the media root. */
export function FolderPicker({
  info,
  onClose,
  onChosen,
}: {
  info: RootInfo;
  onClose: () => void;
  onChosen: (info: RootInfo) => void;
}) {
  const [path, setPath] = useState(info.root);
  const [data, setData] = useState<Browse | null>(null);
  const [cursor, setCursor] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  // Folder to put the cursor on after going up a level.
  const selectAfterLoad = useRef<string | null>(null);
  const rowRefs = useRef<(HTMLLIElement | null)[]>([]);

  const places: { label: string; path: string }[] = [
    ...(info.home ? [{ label: "Home", path: info.home }] : []),
    ...info.volumes.map((v) => ({ label: basename(v), path: v })),
    ...info.recent.map((r) => ({ label: `↺ ${basename(r)}`, path: r })),
  ].slice(0, 9);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    fetch(`/api/browse?path=${encodeURIComponent(path)}`)
      .then(async (res) => {
        const body = await res.json();
        if (!res.ok) throw new Error(body.error ?? "Can't open folder");
        return body as Browse;
      })
      .then((body) => {
        if (cancelled) return;
        setData(body);
        const name = selectAfterLoad.current;
        selectAfterLoad.current = null;
        const idx = name ? body.dirs.indexOf(name) : -1;
        const offset = body.parent ? 2 : 1;
        setCursor(idx >= 0 ? idx + offset : 0);
      })
      .catch((err) => !cancelled && setError(err.message));
    return () => {
      cancelled = true;
    };
  }, [path]);

  const rows: Row[] = [
    { kind: "use" },
    ...(data?.parent ? [{ kind: "up" } as Row] : []),
    ...(data?.dirs ?? []).map((name) => ({ kind: "dir", name }) as Row),
  ];

  useEffect(() => {
    rowRefs.current[cursor]?.scrollIntoView({ block: "nearest" });
  }, [cursor, data]);

  const run = async (
    label: string,
    fn: () => Promise<RootInfo & { cancelled?: boolean }>,
  ) => {
    setBusy(label);
    setError(null);
    try {
      const result = await fn();
      if (!result.cancelled) onChosen(result);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const choose = (p: string) =>
    run("Switching…", () => post("/api/root", { path: p }));
  const pickNative = () =>
    run("Waiting for the Finder dialog on the host…", () =>
      post("/api/root/pick"),
    );

  const goUp = () => {
    if (!data?.parent) return;
    selectAfterLoad.current = basename(data.path);
    setPath(data.parent);
  };

  const activate = (row: Row | undefined) => {
    if (!row || !data) return;
    if (row.kind === "use") void choose(data.path);
    else if (row.kind === "up") goUp();
    else setPath(join(data.path, row.name));
  };

  const onKey = useRef<(e: KeyboardEvent) => void>(() => {});
  onKey.current = (e) => {
    if (busy) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const move = (d: number) => {
      e.preventDefault();
      setCursor((c) => Math.max(0, Math.min(rows.length - 1, c + d)));
    };
    switch (e.key) {
      case "Escape":
        e.preventDefault();
        return onClose();
      case "ArrowDown":
      case "j":
        return move(1);
      case "ArrowUp":
      case "k":
        return move(-1);
      case "PageDown":
        return move(10);
      case "PageUp":
        return move(-10);
      case "g":
      case "Home":
        return move(-rows.length);
      case "G":
      case "End":
        return move(rows.length);
      case "Enter":
      case "ArrowRight":
      case "l":
        e.preventDefault();
        if (e.key !== "Enter" && rows[cursor]?.kind === "use") return;
        return activate(rows[cursor]);
      case "Backspace":
      case "ArrowLeft":
      case "h":
        e.preventDefault();
        return goUp();
      case " ":
        e.preventDefault();
        if (data) void choose(data.path);
        return;
      case "f":
        if (info.canPickNative) void pickNative();
        return;
    }
    const n = Number(e.key);
    if (n >= 1 && n <= places.length) setPath(places[n - 1]!.path);
  };

  useEffect(() => {
    const handler = (e: KeyboardEvent) => onKey.current(e);
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-tui-bg/80 p-4"
      onClick={onClose}
    >
      <div
        className="flex h-[min(640px,85vh)] w-full max-w-2xl flex-col gap-1 border border-tui-fg bg-tui-bg p-4"
        onClick={(e) => e.stopPropagation()}
      >
        <PanelTitle
          title="Open folder"
          focused
          extra={rows.length > 1 ? `[${cursor + 1}/${rows.length}]` : undefined}
        />
        <div className="truncate text-tui-yellow" title={data?.path ?? path}>
          ♫ {data?.path ?? path}
        </div>
        <div className="truncate text-tui-dim">
          now serving <span className="text-tui-fg">{info.root}</span>
        </div>

        {places.length > 0 && (
          <div className="flex flex-wrap gap-x-3 gap-y-1 py-1">
            {places.map((p, i) => (
              <button
                key={p.path}
                tabIndex={-1}
                title={p.path}
                onClick={() => setPath(p.path)}
                className={`flex gap-1 ${data?.path === p.path ? "text-tui-yellow" : ""}`}
              >
                <span className="bg-tui-badge px-1.5 font-bold text-tui-bright">
                  {i + 1}
                </span>
                <span>{p.label}</span>
              </button>
            ))}
          </div>
        )}

        <div className="border-t border-tui-fg" />

        <ul className="min-h-0 flex-1 overflow-y-auto">
          {rows.map((row, i) => {
            const selected = i === cursor;
            return (
              <li
                key={row.kind === "dir" ? row.name : row.kind}
                ref={(el) => {
                  rowRefs.current[i] = el;
                }}
                onClick={() => {
                  setCursor(i);
                  activate(row);
                }}
                className={`flex cursor-pointer gap-2 whitespace-pre hover:bg-tui-badge/40 ${
                  selected ? "font-bold text-tui-yellow" : ""
                }`}
              >
                <span className="w-4 shrink-0">{selected ? ">" : " "}</span>
                {row.kind === "use" ? (
                  <span className={selected ? "" : "text-tui-green"}>
                    ✓ Use this folder
                  </span>
                ) : row.kind === "up" ? (
                  <span>../</span>
                ) : (
                  <span
                    className={`truncate ${selected ? "" : "text-tui-blue"}`}
                  >
                    {row.name}/
                  </span>
                )}
              </li>
            );
          })}
          {data && data.dirs.length === 0 && (
            <li className="pl-6 text-tui-dim">No sub-folders</li>
          )}
        </ul>

        {error && <div className="text-tui-red">✕ {error}</div>}
        {busy && <div className="text-tui-yellow">◌ {busy}</div>}

        <div className="pt-1">
          <KeyHints
            hints={[
              {
                keys: "Enter",
                label: "Open",
                action: () => activate(rows[cursor]),
              },
              {
                keys: "Space",
                label: "Use this folder",
                action: () => data && void choose(data.path),
              },
              { keys: "←", label: "Parent", action: goUp },
              ...(places.length
                ? [{ keys: `1-${places.length}`, label: "Places" }]
                : []),
              ...(info.canPickNative
                ? [
                    {
                      keys: "f",
                      label: "Finder…",
                      action: () => void pickNative(),
                    },
                  ]
                : []),
              { keys: "Esc", label: "Cancel", action: onClose },
            ]}
          />
        </div>
      </div>
    </div>
  );
}
