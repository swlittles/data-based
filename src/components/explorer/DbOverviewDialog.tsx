import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { save } from "@tauri-apps/plugin-dialog";
import { ArrowDown, ArrowUp, Download, Loader2, RefreshCw, Search } from "lucide-react";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { api, errMsg, type CollectionOverview, type DbOverview } from "@/lib/api";
import { formatBytes, formatCount } from "@/lib/bson";
import { saveRowsAsSheet, useNumbersAvailable } from "@/lib/files";
import { terms } from "@/lib/engine";
import { useEngine } from "@/stores/connections";
import { cn } from "@/lib/utils";

/**
 * Database overview: one row per collection with documents, sizes and index
 * footprint, plus the references inferred from sampled ObjectId fields.
 * Flags the things worth acting on (big collections with only the _id index,
 * empty collections, indexes larger than the data) and exports as CSV / JSON.
 *
 * For Postgres the same shape describes a schema: tables / views, planner row
 * estimates, heap vs total (indexes + TOAST) size, and real foreign keys.
 */

interface DbOverviewDialogProps {
  open: boolean;
  database: string;
  onOpenChange: (open: boolean) => void;
  onOpenCollection: (name: string) => void;
}

type SortKey = "name" | "count" | "avgObjSize" | "size" | "storageSize" | "nindexes" | "totalIndexSize";
type Focus = "all" | "unindexed" | "empty" | "heavyIndexes";

/** Big enough that a collection scan hurts. */
const UNINDEXED_MIN_DOCS = 1000;

/** Postgres kinds widen the Mongo union; compare as plain strings. */
const kindOf = (c: CollectionOverview): string => c.kind;
/** Views hold no data of their own (matviews do). */
const isView = (c: CollectionOverview) => kindOf(c) === "view";
/** Mongo collections with only `_id`; Postgres tables with no index at all. */
const isUnindexed = (c: CollectionOverview) =>
  (kindOf(c) === "collection"
    ? (c.nindexes ?? 0) <= 1
    : ["table", "partitioned", "matview"].includes(kindOf(c)) && (c.nindexes ?? 0) === 0) &&
  (c.count ?? 0) >= UNINDEXED_MIN_DOCS;
const isEmpty = (c: CollectionOverview) => !isView(c) && c.count === 0;
const hasHeavyIndexes = (c: CollectionOverview) =>
  (c.size ?? 0) > 0 && (c.totalIndexSize ?? 0) > (c.size ?? 0);

const COLUMNS: { key: SortKey; label: string; numeric?: boolean }[] = [
  { key: "name", label: "Collection" },
  { key: "count", label: "Documents", numeric: true },
  { key: "avgObjSize", label: "Avg doc", numeric: true },
  { key: "size", label: "Data", numeric: true },
  { key: "storageSize", label: "Storage", numeric: true },
  { key: "nindexes", label: "Indexes", numeric: true },
  { key: "totalIndexSize", label: "Index size", numeric: true },
];

const PG_COLUMNS: typeof COLUMNS = [
  { key: "name", label: "Table" },
  { key: "count", label: "Rows (est.)", numeric: true },
  { key: "avgObjSize", label: "Avg row", numeric: true },
  { key: "size", label: "Table", numeric: true },
  { key: "storageSize", label: "Total", numeric: true },
  { key: "nindexes", label: "Indexes", numeric: true },
  { key: "totalIndexSize", label: "Index size", numeric: true },
];

/** Short badge for a non-default kind. */
const KIND_BADGE: Record<string, string> = {
  timeseries: "ts",
  view: "view",
  matview: "mat. view",
  partitioned: "partitioned",
  foreign: "foreign",
};

/** Column names and per-row values shared by the CSV and spreadsheet exports. */
function overviewTable(rows: CollectionOverview[], pg: boolean): { head: string[]; lines: unknown[][] } {
  const head = pg
    ? ["table", "kind", "rowsEstimate", "avgRowBytes", "tableBytes", "totalBytes", "indexes", "indexBytes", "partitioned", "checkConstraints", "foreignKeys"]
    : ["collection", "kind", "documents", "avgDocBytes", "dataBytes", "storageBytes", "indexes", "indexBytes", "capped", "validated", "references"];
  const lines = rows.map((c) => [
    c.name,
    c.kind,
    c.count,
    c.avgObjSize,
    c.size,
    c.storageSize,
    c.nindexes,
    c.totalIndexSize,
    pg ? kindOf(c) === "partitioned" : c.capped,
    c.validated,
    c.refs.map((r) => `${r.field}->${r.to}`).join("; "),
  ]);
  return { head, lines };
}

function toCsv(rows: CollectionOverview[], pg: boolean): string {
  const esc = (v: unknown) => {
    const s = v === null || v === undefined ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const { head, lines } = overviewTable(rows, pg);
  return [head.join(","), ...lines.map((l) => l.map(esc).join(","))].join("\n") + "\n";
}

/** Same columns as the CSV, as objects for the spreadsheet writer. */
function sheetRows(rows: CollectionOverview[], pg: boolean): Record<string, unknown>[] {
  const { head, lines } = overviewTable(rows, pg);
  return lines.map((l) => Object.fromEntries(head.map((h, i) => [h, l[i] ?? null])));
}

export function DbOverviewDialog({ open, database, onOpenChange, onOpenCollection }: DbOverviewDialogProps) {
  const pg = useEngine() === "postgres";
  const t = terms(pg ? "postgres" : "mongo");
  const numbersOk = useNumbersAvailable();
  const columns = pg ? PG_COLUMNS : COLUMNS;
  const [data, setData] = useState<DbOverview | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [focus, setFocus] = useState<Focus>("all");
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: "storageSize", desc: true });

  const load = () => {
    setLoading(true);
    setError(null);
    api
      .dbOverview(database)
      .then(setData)
      .catch((e) => setError(errMsg(e)))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    if (!open || !database) return;
    setData(null);
    setFilter("");
    setFocus("all");
    load();
  }, [open, database]); // eslint-disable-line react-hooks/exhaustive-deps

  const colls = data?.collections ?? [];
  const totals = useMemo(() => {
    const sum = (k: keyof CollectionOverview) => colls.reduce((a, c) => a + (Number(c[k]) || 0), 0);
    return {
      count: sum("count"),
      size: sum("size"),
      storage: sum("storageSize"),
      index: sum("totalIndexSize"),
      refs: colls.reduce((a, c) => a + c.refs.length, 0),
    };
  }, [colls]);

  const insights = useMemo(
    () => ({
      unindexed: colls.filter(isUnindexed).length,
      empty: colls.filter(isEmpty).length,
      heavyIndexes: colls.filter(hasHeavyIndexes).length,
    }),
    [colls]
  );

  const rows = useMemo(() => {
    const f = filter.trim().toLowerCase();
    const pass = (c: CollectionOverview) =>
      (!f || c.name.toLowerCase().includes(f)) &&
      (focus === "all" ||
        (focus === "unindexed" && isUnindexed(c)) ||
        (focus === "empty" && isEmpty(c)) ||
        (focus === "heavyIndexes" && hasHeavyIndexes(c)));
    const out = colls.filter(pass);
    out.sort((a, b) => {
      const dir = sort.desc ? -1 : 1;
      if (sort.key === "name") return dir * a.name.localeCompare(b.name);
      return dir * ((a[sort.key] ?? -1) - (b[sort.key] ?? -1));
    });
    return out;
  }, [colls, filter, focus, sort]);

  const exportAs = async (format: "csv" | "json" | "xlsx" | "numbers") => {
    if (!data) return;
    if (format === "xlsx" || format === "numbers") {
      await saveRowsAsSheet(sheetRows(rows, pg), format, `${database}-overview`, `Export overview of ${database}`);
      return;
    }
    const path = await save({
      title: `Export overview of ${database}`,
      defaultPath: `${database}-overview.${format}`,
      filters: [{ name: format.toUpperCase(), extensions: [format] }],
    }).catch(() => null);
    if (!path) return;
    const content =
      format === "csv"
        ? toCsv(rows, pg)
        : JSON.stringify(
            pg
              ? { schema: database, exportedAt: new Date().toISOString(), tables: rows }
              : { database, exportedAt: new Date().toISOString(), collections: rows },
            null,
            2
          );
    try {
      await api.saveTextFile(path, content);
      toast.success(`Exported ${rows.length} ${rows.length === 1 ? t.coll : t.colls}`);
    } catch (e) {
      toast.error(errMsg(e));
    }
  };

  const toggleSort = (key: SortKey) =>
    setSort((s) => (s.key === key ? { key, desc: !s.desc } : { key, desc: key !== "name" }));

  const chip = (id: Focus, n: number, label: string, tone: "warn" | "dgr" | "") =>
    n > 0 && (
      <button
        type="button"
        className={cn("pill", tone, focus === id && "ring-1 ring-current")}
        onClick={() => setFocus((f) => (f === id ? "all" : id))}
        title={focus === id ? `Show all ${t.colls}` : "Show only these"}
      >
        {n} {label}
      </button>
    );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[980px]">
        <DialogHeader>
          <DialogTitle>{t.Db} overview</DialogTitle>
          <DialogDescription>
            {pg
              ? `${database} · size, indexes and foreign keys per table · click a row to open it`
              : `${database} · storage, indexes and references per collection · click a row to open it`}
          </DialogDescription>
        </DialogHeader>

        <DialogBody>
          {error ? (
            <div className="notice dgr mono">{error}</div>
          ) : !data ? (
            <div className="flex h-[360px] items-center justify-center gap-2 text-[12.5px] text-text-3">
              <Loader2 className="spin h-4 w-4 text-text-3" />
              Reading {t.coll} stats...
            </div>
          ) : (
            <>
              <div className="statgrid five">
                {[
                  [pg ? "Tables" : "Collections", formatCount(colls.length)],
                  [pg ? "Rows (est.)" : "Documents", formatCount(totals.count)],
                  [pg ? "Table data" : "Data", formatBytes(totals.size)],
                  [pg ? "Total size" : "Storage", formatBytes(totals.storage)],
                  ["Indexes", formatBytes(totals.index)],
                ].map(([l, v]) => (
                  <div key={l}>
                    <div className="l">{l}</div>
                    <div className="v mono truncate tabular-nums">{v}</div>
                  </div>
                ))}
              </div>

              <div className="hstack flex-wrap">
                <div className="in sans" style={{ maxWidth: 240, gap: 8 }}>
                  <Search className="h-3.5 w-3.5 shrink-0 text-text-3" />
                  <input
                    className="h-full min-w-0 flex-1 bg-transparent outline-none placeholder:text-text-3"
                    placeholder={`Filter ${t.colls}`}
                    value={filter}
                    onChange={(e) => setFilter(e.target.value)}
                  />
                </div>
                {chip(
                  "unindexed",
                  insights.unindexed,
                  pg
                    ? `with no index (${formatCount(UNINDEXED_MIN_DOCS)}+ rows)`
                    : `with only the _id index (${formatCount(UNINDEXED_MIN_DOCS)}+ docs)`,
                  "warn"
                )}
                {chip("heavyIndexes", insights.heavyIndexes, "with indexes larger than data", "warn")}
                {chip("empty", insights.empty, "empty", "")}
                <div className="ml-auto flex shrink-0 gap-2">
                  <button className="btn qt" onClick={load} disabled={loading}>
                    {loading ? <Loader2 className="spin" /> : <RefreshCw />}
                    Refresh
                  </button>
                  <DropdownMenu modal={false}>
                    <DropdownMenuTrigger asChild>
                      <button className="btn qt" disabled={rows.length === 0}>
                        <Download />
                        Export
                      </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onSelect={() => void exportAs("csv")}>CSV (spreadsheet)</DropdownMenuItem>
                      <DropdownMenuItem onSelect={() => void exportAs("xlsx")}>Excel (.xlsx)</DropdownMenuItem>
                      {numbersOk && <DropdownMenuItem onSelect={() => void exportAs("numbers")}>Numbers (.numbers)</DropdownMenuItem>}
                      <DropdownMenuItem onSelect={() => void exportAs("json")}>JSON</DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </div>

              <div className="max-h-[48vh] overflow-auto rounded-[var(--r-sm)] border border-line">
                <table className="tbl">
                  <thead>
                    <tr>
                      {columns.map((c) => (
                        <th
                          key={c.key}
                          onClick={() => toggleSort(c.key)}
                          className={cn("cursor-pointer select-none hover:text-text", c.numeric && "text-right")}
                        >
                          <span className="inline-flex items-center gap-1">
                            {c.label}
                            {sort.key === c.key &&
                              (sort.desc ? <ArrowDown className="h-3 w-3" /> : <ArrowUp className="h-3 w-3" />)}
                          </span>
                        </th>
                      ))}
                      <th>{pg ? "Foreign keys" : "References"}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((c) => (
                      <tr key={c.name} className="cursor-pointer" onClick={() => onOpenCollection(c.name)}>
                        <td className="text-text">
                          <span className="inline-flex items-center gap-1.5">
                            {c.name}
                            {kindOf(c) !== "collection" && kindOf(c) !== "table" && (
                              <span className="pill">{KIND_BADGE[kindOf(c)] ?? kindOf(c)}</span>
                            )}
                            {c.capped && <span className="pill">capped</span>}
                            {c.validated &&
                              (pg ? (
                                <span className="pill ok" title="Has CHECK constraints">
                                  checks
                                </span>
                              ) : (
                                <span className="pill ok">validated</span>
                              ))}
                            {isUnindexed(c) && <span className="pill warn">{pg ? "no index" : "_id only"}</span>}
                          </span>
                        </td>
                        <td className="text-right tabular-nums" title={pg && isView(c) ? "Views store no rows" : undefined}>
                          {c.count == null ? "-" : formatCount(c.count)}
                        </td>
                        <td className="text-right tabular-nums">{c.avgObjSize == null ? "-" : formatBytes(c.avgObjSize)}</td>
                        <td className="text-right tabular-nums">{c.size == null ? "-" : formatBytes(c.size)}</td>
                        <td className="text-right tabular-nums">{c.storageSize == null ? "-" : formatBytes(c.storageSize)}</td>
                        <td className="text-right tabular-nums">{c.nindexes ?? "-"}</td>
                        <td className={cn("text-right tabular-nums", hasHeavyIndexes(c) && "text-warn")}>
                          {c.totalIndexSize == null ? "-" : formatBytes(c.totalIndexSize)}
                        </td>
                        <td>
                          <span className="inline-flex flex-wrap gap-1">
                            {c.refs.map((r) =>
                              // A schema-qualified target lives in another schema; this dialog
                              // can only open tables in its own.
                              pg && r.to.includes(".") ? (
                                <span
                                  key={`${r.field}->${r.to}`}
                                  className="pill"
                                  title={`${c.name} (${r.field}) references ${r.to}, in another schema`}
                                >
                                  {r.field} → {r.to}
                                </span>
                              ) : (
                                <button
                                  key={`${r.field}->${r.to}`}
                                  type="button"
                                  className="pill hover:text-text"
                                  title={
                                    pg
                                      ? `Foreign key ${c.name} (${r.field}) references ${r.to} - open ${r.to}`
                                      : `${c.name}.${r.field} looks like a reference to ${r.to} - open ${r.to}`
                                  }
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    onOpenCollection(r.to);
                                  }}
                                >
                                  {r.field} → {r.to}
                                </button>
                              )
                            )}
                          </span>
                        </td>
                      </tr>
                    ))}
                    {rows.length === 0 && (
                      <tr>
                        <td colSpan={columns.length + 1} className="py-8 text-center text-text-3">
                          {colls.length === 0 ? `No ${t.colls} in this ${t.db}.` : "No matches."}
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>

              {pg ? (
                <div className="font-mono text-[11px] text-text-3">
                  {formatCount(totals.refs)} foreign key{totals.refs === 1 ? "" : "s"} · row counts are planner
                  estimates (run ANALYZE to refresh) · views store no rows · "checks" marks tables with CHECK
                  constraints
                </div>
              ) : (
                <div className="font-mono text-[11px] text-text-3">
                  {formatCount(totals.refs)} inferred reference{totals.refs === 1 ? "" : "s"} (ObjectId fields named after
                  another collection, from a 25-document sample)
                  {data.refsSkipped > 0 && ` · references not sampled for the last ${data.refsSkipped} collections`}
                </div>
              )}
            </>
          )}
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
