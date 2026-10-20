import {
  EQ_BANDS,
  EQ_PRESETS,
  SPEEDS,
  VOL_MAX,
  VOL_MIN,
  type Net,
  type Repeat,
} from "@/hooks/usePlayer";
import { formatSize } from "@/lib/format";
import { PanelTitle } from "./PanelTitle";

export const SETTING_ROWS = ["SRC", "VOL", "EQ", "SHF", "RPT", "SPD"] as const;
export type SettingRow = (typeof SETTING_ROWS)[number];

/** `3.7 / 5.8 MB` — both numbers in the unit that suits the total. */
function formatPair(loaded: number, total: number) {
  const [unit, div] =
    total >= 1 << 30
      ? ["GB", 1 << 30]
      : total >= 1 << 20
        ? ["MB", 1 << 20]
        : ["KB", 1024];
  return `${(loaded / div).toFixed(1)} / ${(total / div).toFixed(1)} ${unit}`;
}

const bandLabel = (f: number) => (f >= 1000 ? `${f / 1000}k` : String(f));

/** `[value]` with the value in yellow, like the TUI. */
const Bracket = ({ children }: { children: React.ReactNode }) => (
  <span>
    [<span className="text-tui-yellow">{children}</span>]
  </span>
);

function Row({
  name,
  selected,
  onClick,
  children,
}: {
  name: string;
  selected: boolean;
  onClick?: () => void;
  children: React.ReactNode;
}) {
  return (
    <div
      className={`flex cursor-pointer items-start gap-2 ${selected ? "bg-tui-badge/60" : ""}`}
      onClick={onClick}
    >
      <span
        className={`w-8 shrink-0 font-bold ${selected ? "text-tui-yellow" : "text-tui-bright"}`}
      >
        {name}
      </span>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

export function Settings({
  focused,
  row,
  source,
  queuePos,
  volumeDb,
  eq,
  shuffle,
  repeat,
  speed,
  net,
  onChange,
}: {
  focused: boolean;
  row: number;
  source: string;
  queuePos: string | null;
  volumeDb: number;
  eq: number;
  shuffle: boolean;
  repeat: Repeat;
  speed: number;
  net: Net;
  /** Adjust a row by `dir` (-1 / +1); clicking a row cycles it forward. */
  onChange: (row: SettingRow, dir: number) => void;
}) {
  const volPct = ((volumeDb - VOL_MIN) / (VOL_MAX - VOL_MIN)) * 100;
  const gains = EQ_PRESETS[eq]!.gains;
  const rowProps = (name: SettingRow) => ({
    name,
    selected: focused && SETTING_ROWS[row] === name,
    onClick: () => onChange(name, 1),
  });

  return (
    <div className="flex flex-col gap-0">
      <PanelTitle title="Settings" focused={focused} />
      <Row {...rowProps("SRC")}>
        <span className="flex gap-2">
          <span className="truncate">
            <Bracket>{source}</Bracket>
          </span>
          {queuePos && <span className="shrink-0">{queuePos}</span>}
        </span>
      </Row>
      <Row {...rowProps("VOL")}>
        <span className="flex items-center gap-2">
          <span
            className="relative h-[1.1em] flex-1 bg-tui-badge"
            onClick={(e) => {
              e.stopPropagation();
              const r = e.currentTarget.getBoundingClientRect();
              const db =
                VOL_MIN +
                ((e.clientX - r.left) / r.width) * (VOL_MAX - VOL_MIN);
              onChange("VOL", Math.round((db - volumeDb) / 3));
            }}
          >
            <span
              className="absolute inset-y-0 left-0 bg-tui-green"
              style={{ width: `${volPct}%` }}
            />
          </span>
          <span className="w-14 shrink-0 text-right">
            {volumeDb <= VOL_MIN
              ? "MUTE"
              : `${volumeDb >= 0 ? "+" : ""}${volumeDb}dB`}
          </span>
        </span>
      </Row>
      <Row {...rowProps("EQ")}>
        <Bracket>{EQ_PRESETS[eq]!.name}</Bracket>
        <div className="grid grid-cols-5 gap-x-2">
          {EQ_BANDS.map((f, i) => (
            <span
              key={f}
              className={`text-right ${gains[i]! > 0 ? "text-tui-green" : gains[i]! < 0 ? "text-tui-red" : ""}`}
            >
              {bandLabel(f)}
            </span>
          ))}
        </div>
      </Row>
      <Row {...rowProps("SHF")}>
        <Bracket>{shuffle ? "On" : "Off"}</Bracket>
      </Row>
      <Row {...rowProps("RPT")}>
        <Bracket>
          {repeat === "off" ? "Off" : repeat === "all" ? "All" : "One"}
        </Bracket>
      </Row>
      <Row {...rowProps("SPD")}>
        <Bracket>{SPEEDS[speed]}x</Bracket>
      </Row>
      {net.total > 0 && (
        <Row name="NET" selected={false}>
          <span className="flex flex-wrap gap-x-3">
            <span>
              ↓ {formatPair(net.loaded, net.total)} (
              {Math.round((net.loaded / net.total) * 100)}%)
            </span>
            <span className="shrink-0">
              {formatSize(Math.round(net.rate))}/s
            </span>
          </span>
        </Row>
      )}
    </div>
  );
}
