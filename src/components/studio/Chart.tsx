import { useLayoutEffect, useRef, useState } from "react";
import type { ChartKind } from "@/lib/ai";
import { cn } from "@/lib/utils";

/**
 * Single-series Studio charts. Every mark paints with the theme accent, text
 * wears text tokens, and the results table next to the chart is the non-hover
 * way to read every value.
 *   bar    - magnitude by category, horizontal so long labels stay readable
 *   line   - one metric over an ordered axis (time), crosshair tooltip
 *   number - a single headline value
 */
export interface ChartData {
  kind: ChartKind;
  title?: string;
  /** Name of the plotted metric, for the tooltip and the stat tile. */
  metric: string;
  labels: string[];
  values: number[];
}

const BAR_ROW = 26;
const BAR_THICK = 16;
const LINE_H = 240;
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

function Tip({ x, y, value, label, lineKey }: { x: number; y: number; value: string; label: string; lineKey?: boolean }) {
  return (
    <div
      className="pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-full whitespace-nowrap rounded-[var(--r-sm)] border border-line-2 bg-raised px-2.5 py-1.5 shadow-panel"
      style={{ left: x, top: y - 8 }}
      role="status"
    >
      <div className="flex items-center gap-1.5 text-[12.5px] font-semibold text-text">
        {lineKey && <span className="inline-block h-[2px] w-3 rounded-full" style={{ background: "var(--accent)" }} />}
        {value}
      </div>
      <div className="max-w-[260px] truncate text-[11px] text-text-3">{label}</div>
    </div>
  );
}

export function Chart({ data }: { data: ChartData }) {
  if (data.kind === "number") return <StatTile data={data} />;
  if (data.kind === "line") return <LineChart data={data} />;
  return <BarChart data={data} />;
}

function StatTile({ data }: { data: ChartData }) {
  const v = data.values[0];
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

function BarChart({ data }: { data: ChartData }) {
  const [hover, setHover] = useState<number | null>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const lo = Math.min(0, ...data.values);
  const hi = Math.max(0, ...data.values);
  const span = hi - lo || 1;
  const zero = ((0 - lo) / span) * 100;
  const hasNegative = lo < 0;

  const tipFor = (i: number) => {
    const row = wrap.current?.querySelector<HTMLElement>(`[data-bar="${i}"]`);
    const box = wrap.current?.getBoundingClientRect();
    if (!row || !box) return null;
    const r = row.getBoundingClientRect();
    return { x: r.left - box.left + r.width / 2, y: r.top - box.top };
  };
  const tip = hover === null ? null : tipFor(hover);

  return (
    <div ref={wrap} className="relative" onPointerLeave={() => setHover(null)}>
      {data.title && <div className="mb-2 text-[12.5px] font-medium text-text-2">{data.title}</div>}
      <div className="grid items-center gap-x-3" style={{ gridTemplateColumns: "minmax(64px, 32%) 1fr" }}>
        {data.labels.map((label, i) => {
          const v = data.values[i];
          const left = v < 0 ? ((v - lo) / span) * 100 : zero;
          const width = (Math.abs(v) / span) * 100;
          const valueOutsideRight = v >= 0;
          return (
            <div key={i} className="contents">
              <span className="truncate text-right text-[11.5px] text-text-2" title={label} style={{ lineHeight: `${BAR_ROW}px` }}>
                {label}
              </span>
              <div
                className={cn("relative mr-12 outline-none", hasNegative && "ml-12")}
                style={{ height: BAR_ROW }}
                tabIndex={0}
                aria-label={`${label}: ${full(v)}`}
                onPointerEnter={() => setHover(i)}
                onFocus={() => setHover(i)}
                onBlur={() => setHover(null)}
              >
                <div
                  data-bar={i}
                  className="absolute top-1/2 -translate-y-1/2 transition-[filter]"
                  style={{
                    left: `${left}%`,
                    width: `max(${width}%, 2px)`,
                    height: BAR_THICK,
                    background: "var(--accent)",
                    borderRadius: v < 0 ? "4px 0 0 4px" : "0 4px 4px 0",
                    filter: hover === i ? "brightness(1.15)" : undefined,
                    opacity: hover !== null && hover !== i ? 0.55 : 1,
                  }}
                />
                <span
                  className="absolute top-1/2 -translate-y-1/2 whitespace-nowrap font-mono text-[10.5px] tabular-nums text-text-3"
                  style={
                    valueOutsideRight
                      ? { left: `calc(${left + width}% + 6px)` }
                      : { right: `calc(${100 - left}% + 6px)` }
                  }
                >
                  {compact(v)}
                </span>
              </div>
            </div>
          );
        })}
      </div>
      {tip && hover !== null && (
        <Tip x={tip.x} y={tip.y} value={full(data.values[hover])} label={`${data.labels[hover]} · ${data.metric}`} />
      )}
    </div>
  );
}

function LineChart({ data }: { data: ChartData }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const n = data.values.length;
  const lo = Math.min(0, ...data.values);
  const hi = Math.max(...data.values, lo + 1);
  const ticks = niceTicks(lo, hi);
  const yMin = ticks[0];
  const yMax = ticks[ticks.length - 1];
  const plotW = Math.max(10, width - PAD.left - PAD.right);
  const plotH = LINE_H - PAD.top - PAD.bottom;
  const x = (i: number) => PAD.left + (n <= 1 ? plotW / 2 : (i / (n - 1)) * plotW);
  const y = (v: number) => PAD.top + plotH - ((v - yMin) / (yMax - yMin || 1)) * plotH;
  const pts = data.values.map((v, i) => [x(i), y(v)] as const);
  const path = pts.map(([px, py], i) => `${i ? "L" : "M"}${px.toFixed(1)},${py.toFixed(1)}`).join("");
  const area = n ? `${path}L${x(n - 1).toFixed(1)},${y(yMin)}L${x(0).toFixed(1)},${y(yMin)}Z` : "";
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

  return (
    <div className="relative">
      {data.title && <div className="mb-2 text-[12.5px] font-medium text-text-2">{data.title}</div>}
      <div
        ref={ref}
        className="relative outline-none"
        tabIndex={0}
        aria-label={`${data.metric} line chart, ${n} points. Arrow keys step through values.`}
        onKeyDown={onKey}
        onBlur={() => setHover(null)}
      >
        {width > 0 && (
          <svg width={width} height={LINE_H} onPointerMove={onMove} onPointerLeave={() => setHover(null)} className="block">
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
                y={LINE_H - 6}
                textAnchor={i === 0 && n > 1 ? "start" : i === last && n > 1 ? "end" : "middle"}
                className="fill-text-3 text-[10.5px]"
              >
                {data.labels[i].length > 22 ? `${data.labels[i].slice(0, 21)}…` : data.labels[i]}
              </text>
            ))}
            <path d={area} fill="var(--accent)" opacity={0.1} />
            <path d={path} fill="none" stroke="var(--accent)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
            {hover !== null && (
              <line x1={x(hover)} x2={x(hover)} y1={PAD.top} y2={PAD.top + plotH} stroke="var(--line-2)" strokeWidth={1} />
            )}
            {n > 0 && (
              <>
                <circle
                  cx={x(hover ?? last)}
                  cy={y(data.values[hover ?? last])}
                  r={4}
                  fill="var(--accent)"
                  stroke="var(--panel)"
                  strokeWidth={2}
                />
                {hover === null && (
                  <text x={x(last) + 8} y={y(data.values[last])} dy="0.32em" className="fill-text-2 font-mono text-[10.5px] tabular-nums">
                    {compact(data.values[last])}
                  </text>
                )}
              </>
            )}
          </svg>
        )}
        {hover !== null && (
          <Tip x={x(hover)} y={y(data.values[hover])} value={full(data.values[hover])} label={`${data.labels[hover]} · ${data.metric}`} lineKey />
        )}
      </div>
    </div>
  );
}

/** Chart-type switch shown under a result. */
export function ChartKindToggle({ value, onChange }: { value: ChartKind; onChange: (k: ChartKind) => void }) {
  const kinds: { id: ChartKind; label: string }[] = [
    { id: "bar", label: "Bars" },
    { id: "line", label: "Line" },
    { id: "number", label: "Number" },
  ];
  return (
    <div className="seg" role="radiogroup" aria-label="Chart type">
      {kinds.map((k) => (
        <button key={k.id} role="radio" aria-checked={value === k.id} className={cn(value === k.id && "on")} onClick={() => onChange(k.id)}>
          {k.label}
        </button>
      ))}
    </div>
  );
}
