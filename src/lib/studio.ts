import type { Doc } from "@/lib/api";
import type { ChartKind, ChartSpec, VizPlan } from "@/lib/ai";
import type { ChartData } from "@/components/studio/Chart";

/** Categories past this many stop being readable in bars / columns; the
 *  table has the rest. Lines and heatmaps carry more. */
export const MAX_CHART_POINTS = 40;
const MAX_LINE_POINTS = 366;
const MAX_HEAT_ROWS = 20;
/** Categorical slots in the theme (--cat-1..8); a 9th series folds into "Other". */
export const MAX_SERIES = 8;
/** Scatter compares every pair of colours, which only three slots survive. */
const MAX_SCATTER_SERIES = 3;
const MAX_SCATTER_POINTS = 2000;
/** Donut slices before the tail folds into "Other". */
const MAX_SLICES = 6;
export const OTHER = "Other";

export function getPath(doc: Doc, path: string): unknown {
  let cur: unknown = doc;
  for (const part of path.split(".")) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

/** Relaxed Extended JSON value to a short display label. */
export function asLabel(v: unknown): string {
  if (v === null || v === undefined) return "(none)";
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    if ("$oid" in o) return `…${String(o.$oid).slice(-6)}`;
    if ("$date" in o) {
      const d = o.$date;
      const iso = typeof d === "string" ? d : typeof d === "object" && d && "$numberLong" in d ? new Date(Number((d as { $numberLong: string }).$numberLong)).toISOString() : String(d);
      return iso.replace(/T00:00:00(\.000)?Z$/, "").replace(/(\.\d{3})?Z$/, "").replace("T", " ");
    }
    if (Object.keys(o).length === 1) {
      const [k, inner] = Object.entries(o)[0];
      if (k.startsWith("$number")) return String(inner);
    }
    return JSON.stringify(v);
  }
  return String(v);
}

export function asNumber(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "boolean" || v === null || v === undefined) return null;
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    for (const k of ["$numberLong", "$numberDecimal", "$numberInt", "$numberDouble"]) {
      if (k in o) {
        const n = Number(o[k]);
        return Number.isFinite(n) ? n : null;
      }
    }
    return null;
  }
  const n = Number(v);
  return typeof v === "string" && v.trim() !== "" && Number.isFinite(n) ? n : null;
}

/** One (label, series, value) observation pulled out of a result row. */
interface Obs {
  label: string;
  series: string;
  value: number;
}

/** Result rows to observations. Several series come either from a series
 *  column (long format: one row per label x series) or from several value
 *  columns (wide format: one series per column). */
function observations(docs: Doc[], spec: ChartSpec): Obs[] {
  const valueFields = spec.valueFields && spec.valueFields.length > 1 ? spec.valueFields : [spec.valueField];
  const out: Obs[] = [];
  for (const doc of docs) {
    const label = spec.labelField ? asLabel(getPath(doc, spec.labelField)) : spec.valueField;
    for (const field of valueFields) {
      const value = asNumber(getPath(doc, field));
      if (value === null) continue;
      const series = valueFields.length > 1 ? field : spec.seriesField ? asLabel(getPath(doc, spec.seriesField)) : spec.valueField;
      out.push({ label, series, value });
    }
  }
  return out;
}

/** Series names after folding: survivors in first-appearance order (colour
 *  follows the entity, not its rank), "Other" last. */
function orderedSeries(names: string[], fold: Map<string, string>): string[] {
  // A real category called "Other" stays; it merges with a folded tail.
  const folded = names.some((n) => n !== OTHER && fold.get(n) === OTHER);
  const kept = names.filter((n) => fold.get(n) === n && !(folded && n === OTHER));
  return folded ? [...kept, OTHER] : kept;
}

/** Keep the biggest `max - 1` series by total size and sum the rest into
 *  "Other" (only when there are more than `max`). */
function foldSeries(names: string[], obs: Obs[], max: number): Map<string, string> {
  const map = new Map(names.map((n) => [n, n]));
  if (names.length <= max) return map;
  const size = new Map<string, number>();
  for (const o of obs) size.set(o.series, (size.get(o.series) ?? 0) + Math.abs(o.value));
  const keep = new Set([...names].sort((a, b) => (size.get(b) ?? 0) - (size.get(a) ?? 0)).slice(0, max - 1));
  for (const n of names) if (!keep.has(n)) map.set(n, OTHER);
  return map;
}

/** Build chart data from result docs and the plan's chart spec. */
export function chartFromDocs(docs: Doc[], plan: VizPlan, kind: ChartKind): ChartData | null {
  const spec = plan.chart;
  if (!spec) return null;
  const metric = spec.valueFields && spec.valueFields.length > 1 ? spec.valueFields.join(" / ") : spec.valueField;

  if (kind === "scatter") {
    const names: string[] = [];
    const raw: { x: number; y: number; series: string; label: string }[] = [];
    for (const doc of docs) {
      const x = asNumber(getPath(doc, spec.labelField));
      const y = asNumber(getPath(doc, spec.valueField));
      if (x === null || y === null) continue;
      const series = spec.seriesField ? asLabel(getPath(doc, spec.seriesField)) : spec.valueField;
      if (!names.includes(series)) names.push(series);
      raw.push({ x, y, series, label: spec.seriesField ? series : "" });
      if (raw.length >= MAX_SCATTER_POINTS) break;
    }
    if (raw.length < 2) return null;
    const fold = foldSeries(names, raw.map((r) => ({ label: "", series: r.series, value: 1 })), MAX_SCATTER_SERIES);
    const seriesNames = orderedSeries(names, fold);
    return {
      kind,
      title: spec.title,
      metric: spec.valueField,
      xMetric: spec.labelField,
      labels: [],
      series: seriesNames.map((name) => ({ name, values: [], other: name === OTHER && fold.size > seriesNames.length })),
      points: raw.map((r) => ({ x: r.x, y: r.y, s: seriesNames.indexOf(fold.get(r.series)!), label: r.label })),
    };
  }

  const obs = observations(docs, spec);
  if (obs.length === 0) return null;
  const labelLimit = kind === "line" || kind === "area" ? MAX_LINE_POINTS : MAX_CHART_POINTS;
  const labels: string[] = [];
  const names: string[] = [];
  for (const o of obs) {
    if (!labels.includes(o.label)) {
      if (labels.length >= labelLimit) continue;
      labels.push(o.label);
    }
    if (!names.includes(o.series)) names.push(o.series);
  }
  const kept = obs.filter((o) => labels.includes(o.label));

  if (kind === "donut") {
    // Part-to-whole of one series: slices are the labels.
    const totals = labels.map((l) => kept.filter((o) => o.label === l).reduce((a, o) => a + o.value, 0));
    if (totals.some((v) => v < 0) || totals.every((v) => v === 0)) return null;
    const order = labels.map((l, i) => ({ l, v: totals[i] }));
    let slices = order;
    if (order.length > MAX_SLICES) {
      const top = [...order].sort((a, b) => b.v - a.v).slice(0, MAX_SLICES - 1);
      const keep = new Set(top.map((t) => t.l));
      slices = order.filter((o) => keep.has(o.l));
      slices.push({ l: OTHER, v: order.filter((o) => !keep.has(o.l)).reduce((a, o) => a + o.v, 0) });
    }
    return {
      kind,
      title: spec.title,
      metric,
      labels: slices.map((s) => s.l),
      series: [{ name: metric, values: slices.map((s) => s.v) }],
    };
  }

  const heat = kind === "heatmap";
  const fold = foldSeries(names, kept, heat ? MAX_HEAT_ROWS : MAX_SERIES);
  const seriesNames = orderedSeries(names, fold);
  const values = seriesNames.map(() => labels.map(() => null as number | null));
  for (const o of kept) {
    const si = seriesNames.indexOf(fold.get(o.series)!);
    const li = labels.indexOf(o.label);
    values[si][li] = (values[si][li] ?? 0) + o.value;
  }
  return {
    kind,
    title: spec.title,
    metric,
    labels,
    series: seriesNames.map((name, i) => ({ name, values: values[i], other: name === OTHER && fold.size > seriesNames.length })),
  };
}

/** Chart types that fit a result: the plan's own type first, then every
 *  other form the data supports (multi-series data can't be a donut, one
 *  series can't be stacked, scatter needs a numeric x, ...). */
export function chartKindsFor(docs: Doc[], plan: VizPlan): ChartKind[] {
  const spec = plan.chart;
  if (!spec) return [];
  const obs = observations(docs, spec);
  if (obs.length === 0) return [];
  const labels = new Set(obs.map((o) => o.label));
  const series = new Set(obs.map((o) => o.series));
  const multi = series.size > 1;
  const nonNegative = obs.every((o) => o.value >= 0);
  const numericX =
    !!spec.labelField && docs.filter((d) => asNumber(getPath(d, spec.labelField)) !== null).length >= 2;
  const kinds: ChartKind[] = [];
  if (multi) {
    kinds.push("column", "bar");
    if (nonNegative) kinds.push("stacked");
    if (labels.size > 1) kinds.push("line");
    kinds.push("heatmap");
    if (numericX) kinds.push("scatter");
  } else {
    kinds.push("bar", "column");
    if (labels.size > 1) kinds.push("line", "area");
    if (nonNegative && labels.size > 1) kinds.push("donut");
    if (numericX) kinds.push("scatter");
    kinds.push("number");
  }
  const own = spec.type;
  return kinds.includes(own) ? [own, ...kinds.filter((k) => k !== own)] : kinds;
}

export function docsToCsv(docs: Doc[]): string {
  const cols: string[] = [];
  const seen = new Set<string>();
  for (const d of docs) for (const k of Object.keys(d)) if (!seen.has(k)) seen.add(k), cols.push(k);
  const esc = (s: string) => (/[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  const cell = (v: unknown) =>
    v === undefined || v === null ? "" : typeof v === "object" ? esc(asLabel(v)) : esc(String(v));
  return [cols.map(esc).join(","), ...docs.map((d) => cols.map((c) => cell(d[c])).join(","))].join("\n");
}

export function relTime(ts: number, now = Date.now()): string {
  const m = Math.round((now - ts) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}
