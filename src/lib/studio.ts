import type { Doc } from "@/lib/api";
import type { ChartKind, VizPlan } from "@/lib/ai";
import type { ChartData } from "@/components/studio/Chart";

/** Bars past this many categories stop being readable; the table has the rest. */
export const MAX_CHART_POINTS = 40;

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

/** Build chart data from result docs and the plan's label/value fields. */
export function chartFromDocs(docs: Doc[], plan: VizPlan, kind: ChartKind): ChartData | null {
  const spec = plan.chart;
  if (!spec) return null;
  const labels: string[] = [];
  const values: number[] = [];
  for (const doc of docs) {
    const v = asNumber(getPath(doc, spec.valueField));
    if (v === null) continue;
    labels.push(spec.labelField ? asLabel(getPath(doc, spec.labelField)) : spec.valueField);
    values.push(v);
    if (values.length >= MAX_CHART_POINTS) break;
  }
  if (values.length === 0) return null;
  return { kind, title: spec.title, metric: spec.valueField, labels, values };
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
