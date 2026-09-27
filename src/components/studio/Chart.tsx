import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import type { ChartKind } from "@/lib/ai";
import { cn } from "@/lib/utils";

/**
 * Studio charts. One series paints with the theme accent; several series take
 * the theme's categorical slots (--cat-1..8, validated per theme) in fixed
 * order, and a folded tail ("Other") wears the muted text token. Text always
 * wears text tokens. Every chart has a legend for 2+ series, a hover / focus
 * tooltip, and the results table beside it is the non-hover way to read it.
 *   bar      - magnitude by category, horizontal so long labels stay readable
 *   column   - magnitude by category or time bucket, vertical
 *   stacked  - part-to-whole across a second dimension (horizontal)
 *   line     - one or more metrics over an ordered axis, crosshair tooltip
 *   area     - one metric over time, volume emphasised
 *   donut    - share of a whole, at most six slices
 *   scatter  - two numeric fields against each other, at most three series
 *   heatmap  - a metric across two categories, one-hue scale
 *   number   - a single headline value
 */
export interface ChartSeries {
  name: string;
  /** Aligned with `labels`; null where a series has no value for a label. */
  values: (number | null)[];
  /** The folded tail of series past the palette. */
  other?: boolean;
}

export interface ChartData {
  kind: ChartKind;
  title?: string;
  /** Name of the plotted metric, for the tooltip and the stat tile. */
  metric: string;
  labels: string[];
  series: ChartSeries[];
  /** Scatter only: the numeric x field and the points (s = series index). */
  xMetric?: string;
  points?: { x: number; y: number; s: number; label: string }[];
}

const BAR_ROW = 26;
const BAR_THICK = 16;
const GROUP_THICK = 8;
const PLOT_H = 240;
const PAD = { top: 12, right: 56, bottom: 26, left: 52 };

/** 1,284 / 12.9K / 4.2M */
export function compact(v: number): string {
  const a = Math.abs(v);
  if (a >= 1e9) return `${(v / 1e9).toFixed(1).replace(/\.0$/, "")}B`;
  if (a >= 1e6) return `${(v / 1e6).toFixed(1).replace(/\.0$/, "")}M`;
  if (a >= 1e4) return `${(v / 1e3).toFixed(1).replace(/\.0$/, "")}K`;
  return full(v);
}

function full(v: number): string {
  return v.toLocaleString(undefined, { maximumFractionDigits: Number.isInteger(v) ? 0 : 2 });
}

/** Clean axis ticks (0 / 250 / 500 ...) covering [lo, hi]. */
export function niceTicks(lo: number, hi: number, count = 4): number[] {
  if (lo === hi) hi = lo + 1;
  const raw = (hi - lo) / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? 10 * mag;
  const start = Math.floor(lo / step) * step;
  const ticks: number[] = [];
  for (let t = start; t <= hi + step * 1e-9; t += step) ticks.push(Number(t.toPrecision(12)));
  if (ticks[ticks.length - 1] < hi) ticks.push(ticks[ticks.length - 1] + step);
  return ticks;
}

/** Fill for series `i` of `count`: accent alone, categorical slots together. */
export function seriesColor(i: number, count: number, other?: boolean): string {
  if (other) return "var(--text-3)";
  if (count <= 1) return "var(--accent)";
  return `var(--cat-${(i % 8) + 1})`;
}

const numbers = (data: ChartData) => data.series.flatMap((s) => s.values.filter((v): v is number => v !== null));

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    ro.observe(el);
    setWidth(el.getBoundingClientRect().width);
    return () => ro.disconnect();
  }, []);
  return [ref, width] as const;
}

interface TipRow {
  color: string;
  name: string;
  value: string;
  line?: boolean;
}

/** Hover card: a heading plus one row per series (swatch, name, value). */
function Tip({ x, y, title, rows, below }: { x: number; y: number; title: string; rows: TipRow[]; below?: boolean }) {
  return (
    <div
      className={cn(
        "pointer-events-none absolute z-10 -translate-x-1/2 whitespace-nowrap rounded-[var(--r-sm)] border border-line-2 bg-raised px-2.5 py-1.5 shadow-panel",
        !below && "-translate-y-full"
      )}
      style={{ left: x, top: below ? y + 10 : y - 8 }}
      role="status"
    >
      <div className="mb-0.5 max-w-[280px] truncate text-[11px] text-text-3">{title}</div>
      {rows.map((r, i) => (
        <div key={i} className="flex items-center gap-1.5 text-[12px] text-text">
          <span
            className={cn("inline-block shrink-0", r.line ? "h-[2px] w-3 rounded-full" : "h-2 w-2 rounded-[2px]")}
            style={{ background: r.color }}
          />
          {rows.length > 1 && <span className="max-w-[180px] truncate text-text-2">{r.name}</span>}
          <span className="ml-auto pl-2 font-semibold">{r.value}</span>
        </div>
      ))}
    </div>
  );
}

/** Legend for two or more series - identity is never colour alone. */
function Legend({ data, line }: { data: ChartData; line?: boolean }) {
  if (data.series.length < 2) return null;
  return (
    <div className="mb-2 flex flex-wrap gap-x-4 gap-y-1" aria-label="Legend">
      {data.series.map((s, i) => (
        <span key={s.name} className="inline-flex max-w-[220px] items-center gap-1.5 text-[11.5px] text-text-2" title={s.name}>
          <span
            className={cn("inline-block shrink-0", line ? "h-[2px] w-3 rounded-full" : "h-2.5 w-2.5 rounded-[3px]")}
            style={{ background: seriesColor(i, data.series.length, s.other) }}
          />
          <span className="truncate">{s.name}</span>
        </span>
      ))}
    </div>
  );
}

function Title({ data }: { data: ChartData }) {
  return data.title ? <div className="mb-2 text-[12.5px] font-medium text-text-2">{data.title}</div> : null;
}

/** Tooltip rows for label `i` across every series. */
const rowsAt = (data: ChartData, i: number, line = false): TipRow[] =>
  data.series
    .map((s, si) => ({ s, si }))
    .filter(({ s }) => s.values[i] !== null)
    .map(({ s, si }) => ({
      color: seriesColor(si, data.series.length, s.other),
      name: s.name,
      value: full(s.values[i]!),
      line,
    }));

export function Chart({ data }: { data: ChartData }) {
  switch (data.kind) {
    case "number":
      return <StatTile data={data} />;
    case "line":
    case "area":
      return <LineChart data={data} />;
    case "column":
      return <ColumnChart data={data} />;
    case "stacked":
      return <StackedBars data={data} />;
    case "donut":
      return <Donut data={data} />;
    case "scatter":
      return <Scatter data={data} />;
    case "heatmap":
      return <Heatmap data={data} />;
    default:
      return <BarChart data={data} />;
  }
}

function StatTile({ data }: { data: ChartData }) {
  const v = data.series[0]?.values.find((x): x is number => x !== null);
  return (
    <div className="flex flex-col gap-1 px-1 py-2">
      <span className="text-[12px] text-text-3">{data.title || data.metric}</span>
      <span className="font-sans text-[48px] font-semibold leading-none tracking-[-0.02em] text-text">
        {v === undefined ? "-" : compact(v)}
      </span>
      {v !== undefined && Math.abs(v) >= 1e4 && <span className="font-mono text-[11px] text-text-3">{full(v)}</span>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// horizontal bars (single or grouped)
// ---------------------------------------------------------------------------

function BarChart({ data }: { data: ChartData }) {
  const [hover, setHover] = useState<number | null>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const all = numbers(data);
  const lo = Math.min(0, ...all);
  const hi = Math.max(0, ...all);
  const span = hi - lo || 1;
  const zero = ((0 - lo) / span) * 100;
  const hasNegative = lo < 0;
  const n = data.series.length;
  const thick = n === 1 ? BAR_THICK : GROUP_THICK;
  const rowH = n === 1 ? BAR_ROW : n * thick + (n - 1) * 2 + 10;

  const tipFor = (i: number) => {
    const row = wrap.current?.querySelector<HTMLElement>(`[data-row="${i}"]`);
    const box = wrap.current?.getBoundingClientRect();
    if (!row || !box) return null;
    const r = row.getBoundingClientRect();
    return { x: r.left - box.left + r.width / 2, y: r.top - box.top };
  };
  const tip = hover === null ? null : tipFor(hover);

  return (
    <div ref={wrap} className="relative" onPointerLeave={() => setHover(null)}>
      <Title data={data} />
      <Legend data={data} />
      <div className="grid items-center gap-x-3" style={{ gridTemplateColumns: "minmax(64px, 32%) 1fr" }}>
        {data.labels.map((label, i) => (
          <div key={i} className="contents">
            <span className="truncate text-right text-[11.5px] text-text-2" title={label} style={{ lineHeight: `${rowH}px` }}>
              {label}
            </span>
            <div
              data-row={i}
              className={cn("relative mr-12 outline-none", hasNegative && "ml-12")}
              style={{ height: rowH }}
              tabIndex={0}
              aria-label={`${label}: ${rowsAt(data, i).map((r) => `${r.name} ${r.value}`).join(", ")}`}
              onPointerEnter={() => setHover(i)}
              onFocus={() => setHover(i)}
              onBlur={() => setHover(null)}
            >
              {data.series.map((s, si) => {
                const v = s.values[i];
                if (v === null) return null;
                const left = v < 0 ? ((v - lo) / span) * 100 : zero;
                const width = (Math.abs(v) / span) * 100;
                const top = n === 1 ? (rowH - thick) / 2 : 5 + si * (thick + 2);
                return (
                  <div key={si}>
                    <div
                      className="absolute transition-[filter]"
                      style={{
                        top,
                        left: `${left}%`,
                        width: `max(${width}%, 2px)`,
                        height: thick,
                        background: seriesColor(si, n, s.other),
                        borderRadius: v < 0 ? "4px 0 0 4px" : "0 4px 4px 0",
                        filter: hover === i ? "brightness(1.15)" : undefined,
                        opacity: hover !== null && hover !== i ? 0.55 : 1,
                      }}
                    />
                    {n === 1 && (
                      <span
                        className="absolute top-1/2 -translate-y-1/2 whitespace-nowrap font-mono text-[10.5px] tabular-nums text-text-3"
                        style={v >= 0 ? { left: `calc(${left + width}% + 6px)` } : { right: `calc(${100 - left}% + 6px)` }}
                      >
                        {compact(v)}
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
      {tip && hover !== null && <Tip x={tip.x} y={tip.y} title={n === 1 ? `${data.labels[hover]} · ${data.metric}` : data.labels[hover]} rows={rowsAt(data, hover)} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// vertical columns (single or grouped)
// ---------------------------------------------------------------------------

/** Column path with 4px rounded data end, square at the baseline. */
function columnPath(x: number, w: number, base: number, top: number): string {
  const r = Math.min(4, w / 2, Math.abs(base - top));
  if (top <= base) {
    return `M${x},${base}V${top + r}Q${x},${top} ${x + r},${top}H${x + w - r}Q${x + w},${top} ${x + w},${top + r}V${base}Z`;
  }
  return `M${x},${base}V${top - r}Q${x},${top} ${x + r},${top}H${x + w - r}Q${x + w},${top} ${x + w},${top - r}V${base}Z`;
}

function ColumnChart({ data }: { data: ChartData }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const all = numbers(data);
  const ticks = niceTicks(Math.min(0, ...all), Math.max(0, ...all, 1));
  const yMin = ticks[0];
  const yMax = ticks[ticks.length - 1];
  const plotW = Math.max(10, width - PAD.left - 16);
  const plotH = PLOT_H - PAD.top - PAD.bottom;
  const y = (v: number) => PAD.top + plotH - ((v - yMin) / (yMax - yMin || 1)) * plotH;
  const n = data.labels.length;
  const k = data.series.length;
  const group = plotW / Math.max(1, n);
  const inner = group * (k === 1 ? 0.62 : 0.78);
  const colW = Math.max(2, (inner - (k - 1) * 2) / k);
  const every = Math.max(1, Math.ceil(n / Math.max(1, Math.floor(plotW / 64))));
  const gx = (i: number) => PAD.left + i * group + (group - inner) / 2;

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowRight") setHover((h) => Math.min(n - 1, (h ?? -1) + 1));
    else if (e.key === "ArrowLeft") setHover((h) => Math.max(0, (h ?? n) - 1));
    else return;
    e.preventDefault();
  };

  return (
    <div className="relative">
      <Title data={data} />
      <Legend data={data} />
      <div
        ref={ref}
        className="relative outline-none"
        tabIndex={0}
        aria-label={`${data.metric} column chart, ${n} categories. Arrow keys step through values.`}
        onKeyDown={onKey}
        onBlur={() => setHover(null)}
      >
        {width > 0 && (
          <svg width={width} height={PLOT_H} className="block" onPointerLeave={() => setHover(null)}>
            {ticks.map((t) => (
              <g key={t}>
                <line x1={PAD.left} x2={PAD.left + plotW} y1={y(t)} y2={y(t)} stroke="var(--line)" strokeWidth={1} />
                <text x={PAD.left - 8} y={y(t)} dy="0.32em" textAnchor="end" className="fill-text-3 font-mono text-[10px] tabular-nums">
                  {compact(t)}
                </text>
              </g>
            ))}
            {data.labels.map((label, i) => (
              <g key={i} opacity={hover !== null && hover !== i ? 0.55 : 1}>
                {data.series.map((s, si) => {
                  const v = s.values[i];
                  if (v === null) return null;
                  return (
                    <path
                      key={si}
                      d={columnPath(gx(i) + si * (colW + 2), colW, y(0), y(v))}
                      fill={seriesColor(si, k, s.other)}
                    />
                  );
                })}
                {i % every === 0 && (
                  <text x={PAD.left + i * group + group / 2} y={PLOT_H - 6} textAnchor="middle" className="fill-text-3 text-[10.5px]">
                    {label.length > 12 ? `${label.slice(0, 11)}…` : label}
                  </text>
                )}
                {/* Hit area: the whole column slot, not just the mark. */}
                <rect
                  x={PAD.left + i * group}
                  y={PAD.top}
                  width={group}
                  height={plotH}
                  fill="transparent"
                  onPointerEnter={() => setHover(i)}
                />
              </g>
            ))}
          </svg>
        )}
        {hover !== null && width > 0 && (
          <Tip
            x={PAD.left + hover * group + group / 2}
            y={y(Math.max(0, ...data.series.map((s) => s.values[hover] ?? 0)))}
            title={k === 1 ? `${data.labels[hover]} · ${data.metric}` : data.labels[hover]}
            rows={rowsAt(data, hover)}
          />
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// stacked horizontal bars
// ---------------------------------------------------------------------------

function StackedBars({ data }: { data: ChartData }) {
  const [hover, setHover] = useState<{ row: number; seg: number } | null>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const totals = data.labels.map((_, i) => data.series.reduce((a, s) => a + Math.max(0, s.values[i] ?? 0), 0));
  const max = Math.max(...totals, 1);
  const k = data.series.length;

  const tipFor = (row: number, seg: number) => {
    const el = wrap.current?.querySelector<HTMLElement>(`[data-seg="${row}-${seg}"]`);
    const box = wrap.current?.getBoundingClientRect();
    if (!el || !box) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left - box.left + r.width / 2, y: r.top - box.top };
  };
  const tip = hover ? tipFor(hover.row, hover.seg) : null;

  return (
    <div ref={wrap} className="relative" onPointerLeave={() => setHover(null)}>
      <Title data={data} />
      <Legend data={data} />
      <div className="grid items-center gap-x-3" style={{ gridTemplateColumns: "minmax(64px, 32%) 1fr" }}>
        {data.labels.map((label, i) => (
          <div key={i} className="contents">
            <span className="truncate text-right text-[11.5px] text-text-2" title={label} style={{ lineHeight: `${BAR_ROW}px` }}>
              {label}
            </span>
            <div className="relative mr-14 flex items-center" style={{ height: BAR_ROW }}>
              <div className="flex h-4 gap-[2px]" style={{ width: `${(totals[i] / max) * 100}%` }}>
                {data.series.map((s, si) => {
                  const v = Math.max(0, s.values[i] ?? 0);
                  if (v === 0) return null;
                  // Only the outer end of the stack is rounded.
                  const last = data.series.length - 1 - [...data.series].reverse().findIndex((x) => (x.values[i] ?? 0) > 0) === si;
                  return (
                    <div
                      key={si}
                      data-seg={`${i}-${si}`}
                      tabIndex={0}
                      aria-label={`${label}, ${s.name}: ${full(v)}`}
                      className="h-full min-w-[2px] outline-none"
                      style={{
                        flexGrow: v,
                        flexBasis: 0,
                        background: seriesColor(si, k, s.other),
                        borderRadius: last ? "0 4px 4px 0" : 0,
                        opacity: hover && !(hover.row === i && hover.seg === si) ? 0.55 : 1,
                      }}
                      onPointerEnter={() => setHover({ row: i, seg: si })}
                      onFocus={() => setHover({ row: i, seg: si })}
                      onBlur={() => setHover(null)}
                    />
                  );
                })}
              </div>
              <span className="ml-1.5 whitespace-nowrap font-mono text-[10.5px] tabular-nums text-text-3">{compact(totals[i])}</span>
            </div>
          </div>
        ))}
      </div>
      {tip && hover && (
        <Tip
          x={tip.x}
          y={tip.y}
          title={data.labels[hover.row]}
          rows={[
            {
              color: seriesColor(hover.seg, k, data.series[hover.seg].other),
              name: data.series[hover.seg].name,
              value: `${full(data.series[hover.seg].values[hover.row] ?? 0)} · ${Math.round(((data.series[hover.seg].values[hover.row] ?? 0) / (totals[hover.row] || 1)) * 100)}%`,
            },
          ]}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// line / area
// ---------------------------------------------------------------------------

function LineChart({ data }: { data: ChartData }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const n = data.labels.length;
  const k = data.series.length;
  const area = data.kind === "area" && k === 1;
  const all = numbers(data);
  const lo = Math.min(0, ...all);
  const hi = Math.max(...all, lo + 1);
  const ticks = niceTicks(lo, hi);
  const yMin = ticks[0];
  const yMax = ticks[ticks.length - 1];
  const plotW = Math.max(10, width - PAD.left - PAD.right);
  const plotH = PLOT_H - PAD.top - PAD.bottom;
  const x = (i: number) => PAD.left + (n <= 1 ? plotW / 2 : (i / (n - 1)) * plotW);
  const y = (v: number) => PAD.top + plotH - ((v - yMin) / (yMax - yMin || 1)) * plotH;
  // Missing values break the line instead of dropping to zero.
  const paths = data.series.map((s) => {
    let d = "";
    let pen = false;
    s.values.forEach((v, i) => {
      if (v === null) {
        pen = false;
        return;
      }
      d += `${pen ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
      pen = true;
    });
    return d;
  });
  const first = data.series[0]?.values ?? [];
  const firstIdx = first.findIndex((v) => v !== null);
  const lastIdx = first.length - 1 - [...first].reverse().findIndex((v) => v !== null);
  const areaPath =
    area && firstIdx >= 0 ? `${paths[0]}L${x(lastIdx).toFixed(1)},${y(yMin)}L${x(firstIdx).toFixed(1)},${y(yMin)}Z` : "";
  // First, middle and last x labels: enough to orient without collisions.
  const xLabels = [...new Set([0, Math.floor((n - 1) / 2), n - 1])].filter((i) => i >= 0 && (n < 3 || i === 0 || i === n - 1 || plotW > 260));
  const last = n - 1;

  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - box.left - PAD.left;
    setHover(Math.max(0, Math.min(n - 1, Math.round(n <= 1 ? 0 : (px / plotW) * (n - 1)))));
  };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowRight") setHover((h) => Math.min(n - 1, (h ?? -1) + 1));
    else if (e.key === "ArrowLeft") setHover((h) => Math.max(0, (h ?? n) - 1));
    else return;
    e.preventDefault();
  };
  const at = hover ?? last;
  const tipY = Math.min(...data.series.map((s) => (s.values[at] === null ? Infinity : y(s.values[at]!))));

  return (
    <div className="relative">
      <Title data={data} />
      <Legend data={data} line />
      <div
        ref={ref}
        className="relative outline-none"
        tabIndex={0}
        aria-label={`${data.metric} ${area ? "area" : "line"} chart, ${n} points. Arrow keys step through values.`}
        onKeyDown={onKey}
        onBlur={() => setHover(null)}
      >
        {width > 0 && (
          <svg width={width} height={PLOT_H} onPointerMove={onMove} onPointerLeave={() => setHover(null)} className="block">
            {ticks.map((t) => (
              <g key={t}>
                <line x1={PAD.left} x2={PAD.left + plotW} y1={y(t)} y2={y(t)} stroke="var(--line)" strokeWidth={1} />
                <text x={PAD.left - 8} y={y(t)} dy="0.32em" textAnchor="end" className="fill-text-3 font-mono text-[10px] tabular-nums">
                  {compact(t)}
                </text>
              </g>
            ))}
            {xLabels.map((i) => (
              <text
                key={i}
                x={x(i)}
                y={PLOT_H - 6}
                textAnchor={i === 0 && n > 1 ? "start" : i === last && n > 1 ? "end" : "middle"}
                className="fill-text-3 text-[10.5px]"
              >
                {data.labels[i].length > 22 ? `${data.labels[i].slice(0, 21)}…` : data.labels[i]}
              </text>
            ))}
            {area && <path d={areaPath} fill="var(--accent)" opacity={0.1} />}
            {paths.map((d, si) => (
              <path
                key={si}
                d={d}
                fill="none"
                stroke={seriesColor(si, k, data.series[si].other)}
                strokeWidth={2}
                strokeLinejoin="round"
                strokeLinecap="round"
              />
            ))}
            {hover !== null && (
              <line x1={x(hover)} x2={x(hover)} y1={PAD.top} y2={PAD.top + plotH} stroke="var(--line-2)" strokeWidth={1} />
            )}
            {n > 0 &&
              data.series.map((s, si) =>
                s.values[at] === null ? null : (
                  <circle
                    key={si}
                    cx={x(at)}
                    cy={y(s.values[at]!)}
                    r={4}
                    fill={seriesColor(si, k, s.other)}
                    stroke="var(--panel)"
                    strokeWidth={2}
                  />
                )
              )}
            {hover === null && k === 1 && n > 0 && first[last] !== null && (
              <text x={x(last) + 8} y={y(first[last]!)} dy="0.32em" className="fill-text-2 font-mono text-[10.5px] tabular-nums">
                {compact(first[last]!)}
              </text>
            )}
          </svg>
        )}
        {hover !== null && Number.isFinite(tipY) && (
          <Tip
            x={x(hover)}
            y={tipY}
            title={k === 1 ? `${data.labels[hover]} · ${data.metric}` : data.labels[hover]}
            rows={rowsAt(data, hover, true)}
          />
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// donut
// ---------------------------------------------------------------------------

function arc(cx: number, cy: number, r: number, a0: number, a1: number): string {
  const p = (a: number) => [cx + r * Math.sin(a), cy - r * Math.cos(a)];
  const [x0, y0] = p(a0);
  const [x1, y1] = p(a1);
  return `M${x0},${y0}A${r},${r} 0 ${a1 - a0 > Math.PI ? 1 : 0} 1 ${x1},${y1}`;
}

function Donut({ data }: { data: ChartData }) {
  const [hover, setHover] = useState<number | null>(null);
  const values = data.series[0]?.values.map((v) => Math.max(0, v ?? 0)) ?? [];
  const total = values.reduce((a, v) => a + v, 0) || 1;
  const size = 196;
  const r = 78;
  const thick = 26;
  const k = data.labels.length;
  const color = (i: number) => seriesColor(i, Math.max(2, k), data.labels[i] === "Other" && i === k - 1);
  let a = 0;
  const slices = values.map((v, i) => {
    const a0 = a;
    a += (v / total) * Math.PI * 2;
    return { i, a0, a1: a, v };
  });
  const shown = hover ?? null;

  return (
    <div className="flex flex-wrap items-center gap-6">
      <div className="relative">
        <Title data={data} />
        <svg width={size} height={size} role="img" aria-label={`${data.metric} share across ${k} slices`}>
          {slices.map((s) =>
            s.v <= 0 ? null : s.a1 - s.a0 >= Math.PI * 2 - 1e-6 ? (
              <circle
                key={s.i}
                cx={size / 2}
                cy={size / 2}
                r={r}
                fill="none"
                stroke={color(s.i)}
                strokeWidth={thick}
                onPointerEnter={() => setHover(s.i)}
                onPointerLeave={() => setHover(null)}
              />
            ) : (
              <path
                key={s.i}
                d={arc(size / 2, size / 2, r, s.a0, s.a1)}
                fill="none"
                stroke={color(s.i)}
                strokeWidth={hover === s.i ? thick + 4 : thick}
                opacity={hover !== null && hover !== s.i ? 0.55 : 1}
                tabIndex={0}
                aria-label={`${data.labels[s.i]}: ${full(s.v)} (${Math.round((s.v / total) * 100)}%)`}
                className="outline-none"
                onPointerEnter={() => setHover(s.i)}
                onPointerLeave={() => setHover(null)}
                onFocus={() => setHover(s.i)}
                onBlur={() => setHover(null)}
              />
            )
          )}
          {/* 2px surface gaps between slices */}
          {k > 1 &&
            slices.map((s) =>
              s.v <= 0 ? null : (
                <line
                  key={`g${s.i}`}
                  x1={size / 2 + (r - thick / 2 - 3) * Math.sin(s.a0)}
                  y1={size / 2 - (r - thick / 2 - 3) * Math.cos(s.a0)}
                  x2={size / 2 + (r + thick / 2 + 3) * Math.sin(s.a0)}
                  y2={size / 2 - (r + thick / 2 + 3) * Math.cos(s.a0)}
                  stroke="var(--panel)"
                  strokeWidth={2}
                  pointerEvents="none"
                />
              )
            )}
          <text x={size / 2} y={size / 2 - 6} textAnchor="middle" className="fill-text font-sans text-[20px] font-semibold">
            {compact(shown !== null ? values[shown] : total)}
          </text>
          <text x={size / 2} y={size / 2 + 14} textAnchor="middle" className="fill-text-3 text-[11px]">
            {shown !== null
              ? `${data.labels[shown].length > 18 ? `${data.labels[shown].slice(0, 17)}…` : data.labels[shown]} · ${Math.round((values[shown] / total) * 100)}%`
              : `total ${data.metric.length > 14 ? "" : data.metric}`}
          </text>
        </svg>
      </div>
      {/* The legend is the direct label: name, value and share for every slice. */}
      <div className="flex min-w-[180px] flex-col gap-1">
        {data.labels.map((label, i) => (
          <div
            key={i}
            className={cn("flex items-center gap-2 text-[12px]", hover !== null && hover !== i && "opacity-60")}
            onPointerEnter={() => setHover(i)}
            onPointerLeave={() => setHover(null)}
          >
            <span className="inline-block h-2.5 w-2.5 shrink-0 rounded-[3px]" style={{ background: color(i) }} />
            <span className="max-w-[200px] truncate text-text-2" title={label}>
              {label}
            </span>
            <span className="ml-auto pl-3 font-mono text-[11px] tabular-nums text-text">{compact(values[i])}</span>
            <span className="w-9 text-right font-mono text-[11px] tabular-nums text-text-3">{Math.round((values[i] / total) * 100)}%</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// scatter
// ---------------------------------------------------------------------------

function Scatter({ data }: { data: ChartData }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const pts = data.points ?? [];
  const k = data.series.length;
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  const xt = niceTicks(Math.min(...xs), Math.max(...xs));
  const yt = niceTicks(Math.min(...ys), Math.max(...ys));
  const plotW = Math.max(10, width - PAD.left - 20);
  const plotH = PLOT_H + 20 - PAD.top - PAD.bottom;
  const X = (v: number) => PAD.left + ((v - xt[0]) / (xt[xt.length - 1] - xt[0] || 1)) * plotW;
  const Y = (v: number) => PAD.top + plotH - ((v - yt[0]) / (yt[yt.length - 1] - yt[0] || 1)) * plotH;
  const H = PLOT_H + 20;

  // Nearest point within 24px: dots are small, the target isn't.
  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    const mx = e.clientX - box.left;
    const my = e.clientY - box.top;
    let best = -1;
    let dist = 24 * 24;
    pts.forEach((p, i) => {
      const d = (X(p.x) - mx) ** 2 + (Y(p.y) - my) ** 2;
      if (d < dist) {
        dist = d;
        best = i;
      }
    });
    setHover(best >= 0 ? best : null);
  };
  const hp = hover !== null ? pts[hover] : null;

  return (
    <div className="relative">
      <Title data={data} />
      <Legend data={data} />
      <div ref={ref} className="relative">
        {width > 0 && (
          <svg width={width} height={H} className="block" onPointerMove={onMove} onPointerLeave={() => setHover(null)} role="img" aria-label={`${data.metric} against ${data.xMetric}, ${pts.length} points`}>
            {yt.map((t) => (
              <g key={`y${t}`}>
                <line x1={PAD.left} x2={PAD.left + plotW} y1={Y(t)} y2={Y(t)} stroke="var(--line)" strokeWidth={1} />
                <text x={PAD.left - 8} y={Y(t)} dy="0.32em" textAnchor="end" className="fill-text-3 font-mono text-[10px] tabular-nums">
                  {compact(t)}
                </text>
              </g>
            ))}
            {xt.map((t) => (
              <text key={`x${t}`} x={X(t)} y={H - 8} textAnchor="middle" className="fill-text-3 font-mono text-[10px] tabular-nums">
                {compact(t)}
              </text>
            ))}
            {pts.map((p, i) => (
              <circle
                key={i}
                cx={X(p.x)}
                cy={Y(p.y)}
                r={hover === i ? 5.5 : 4}
                fill={seriesColor(p.s, k, data.series[p.s]?.other)}
                fillOpacity={pts.length > 300 ? 0.7 : 1}
                stroke="var(--panel)"
                strokeWidth={2}
              />
            ))}
          </svg>
        )}
        {width > 0 && data.xMetric && (
          <div className="mt-0.5 text-center text-[10.5px] text-text-3">
            {data.xMetric} → · ↑ {data.metric}
          </div>
        )}
        {hp && (
          <Tip
            x={X(hp.x)}
            y={Y(hp.y)}
            title={hp.label || `${data.xMetric} ${full(hp.x)}`}
            rows={[
              { color: seriesColor(hp.s, k, data.series[hp.s]?.other), name: data.xMetric ?? "x", value: full(hp.x) },
              { color: seriesColor(hp.s, k, data.series[hp.s]?.other), name: data.metric, value: full(hp.y) },
            ]}
          />
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// heatmap
// ---------------------------------------------------------------------------

/** One-hue sequential step: the accent mixed into the surface by intensity. */
const heat = (t: number) => `color-mix(in oklab, var(--accent) ${Math.round(12 + t * 88)}%, var(--panel))`;

function Heatmap({ data }: { data: ChartData }) {
  const [hover, setHover] = useState<{ r: number; c: number } | null>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const all = numbers(data);
  const lo = Math.min(...all);
  const hi = Math.max(...all);
  const t = (v: number) => (hi === lo ? 1 : (v - lo) / (hi - lo));
  const cols = data.labels.length;
  const rows = data.series.length;
  const cellMin = 18;
  const tipAt = useMemo(() => {
    if (!hover || !wrap.current) return null;
    const el = wrap.current.querySelector<HTMLElement>(`[data-cell="${hover.r}-${hover.c}"]`);
    const box = wrap.current.getBoundingClientRect();
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left - box.left + r.width / 2, y: r.top - box.top };
  }, [hover]);

  const onKey = (e: React.KeyboardEvent) => {
    const cur = hover ?? { r: 0, c: -1 };
    const next =
      e.key === "ArrowRight" ? { ...cur, c: Math.min(cols - 1, cur.c + 1) }
      : e.key === "ArrowLeft" ? { ...cur, c: Math.max(0, cur.c - 1) }
      : e.key === "ArrowDown" ? { ...cur, r: Math.min(rows - 1, cur.r + 1), c: Math.max(0, cur.c) }
      : e.key === "ArrowUp" ? { ...cur, r: Math.max(0, cur.r - 1), c: Math.max(0, cur.c) }
      : null;
    if (!next) return;
    e.preventDefault();
    setHover(next);
  };

  return (
    <div ref={wrap} className="relative">
      <Title data={data} />
      <div
        className="overflow-x-auto outline-none"
        tabIndex={0}
        aria-label={`${data.metric} heatmap, ${rows} rows by ${cols} columns. Arrow keys move between cells.`}
        onKeyDown={onKey}
        onBlur={() => setHover(null)}
        onPointerLeave={() => setHover(null)}
      >
        <div
          className="grid gap-[2px]"
          style={{ gridTemplateColumns: `minmax(72px, max-content) repeat(${cols}, minmax(${cellMin}px, 1fr))`, minWidth: 72 + cols * (cellMin + 2) }}
        >
          <span />
          {data.labels.map((l, c) => (
            <span key={c} className="truncate pb-1 text-center text-[10px] text-text-3" title={l}>
              {cols > 24 && c % Math.ceil(cols / 24) !== 0 ? "" : l}
            </span>
          ))}
          {data.series.map((s, r) => (
            <div key={r} className="contents">
              <span className="truncate pr-2 text-right text-[11px] leading-[22px] text-text-2" title={s.name}>
                {s.name}
              </span>
              {s.values.map((v, c) => (
                <div
                  key={c}
                  data-cell={`${r}-${c}`}
                  className="h-[22px] rounded-[3px]"
                  style={{
                    background: v === null ? "var(--panel-2)" : heat(t(v)),
                    outline: hover && hover.r === r && hover.c === c ? "2px solid var(--text)" : undefined,
                  }}
                  onPointerEnter={() => setHover({ r, c })}
                />
              ))}
            </div>
          ))}
        </div>
      </div>
      {/* Scale legend: the ramp from lowest to highest value. */}
      <div className="mt-2 flex items-center gap-2 text-[10.5px] text-text-3">
        <span className="font-mono tabular-nums">{compact(lo)}</span>
        <span className="h-2 w-32 rounded-full" style={{ background: `linear-gradient(to right, ${heat(0)}, ${heat(1)})` }} />
        <span className="font-mono tabular-nums">{compact(hi)}</span>
        <span className="ml-1">{data.metric}</span>
      </div>
      {hover && tipAt && data.series[hover.r].values[hover.c] !== null && (
        <Tip
          x={tipAt.x}
          y={tipAt.y}
          title={`${data.series[hover.r].name} · ${data.labels[hover.c]}`}
          rows={[{ color: heat(t(data.series[hover.r].values[hover.c]!)), name: data.metric, value: full(data.series[hover.r].values[hover.c]!) }]}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// type picker
// ---------------------------------------------------------------------------

export const KIND_LABEL: Record<ChartKind, string> = {
  bar: "Bars",
  column: "Columns",
  stacked: "Stacked bars",
  line: "Line",
  area: "Area",
  donut: "Donut",
  scatter: "Scatter",
  heatmap: "Heatmap",
  number: "Number",
};

/** Chart-type switch shown under a result: only the forms the data fits. */
export function ChartKindToggle({ value, kinds, onChange }: { value: ChartKind; kinds: ChartKind[]; onChange: (k: ChartKind) => void }) {
  if (kinds.length <= 1) return null;
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <button className="btn qt sm" aria-label="Chart type">
          {KIND_LABEL[value]}
          <ChevronDown style={{ width: 12, height: 12, opacity: 0.7 }} />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        {kinds.map((k) => (
          <DropdownMenuItem key={k} className={cn(k === value && "text-primary")} onSelect={() => onChange(k)}>
            {KIND_LABEL[k]}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
