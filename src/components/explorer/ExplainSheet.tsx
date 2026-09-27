import { useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, Loader2, Sparkles } from "lucide-react";
import { toast } from "sonner";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { api, errMsg, type Doc, type ExplainSummary, type StageInput } from "@/lib/api";
import { formatCount } from "@/lib/bson";
import { sqlIdent } from "@/lib/engine";
import { cn } from "@/lib/utils";
import { formatUsage, interpretExplain } from "@/lib/ai";
import { AI_NOT_READY, useAi } from "@/stores/ai";
import { useEngine } from "@/stores/connections";
import { PgPlanTree } from "./PgPlanTree";

export interface ExplainRequest {
  database: string;
  collection: string;
  filter: string;
  sort: string;
  projection: string;
  pipelineStages?: StageInput[];
  /** PostgreSQL: page size, used as the LIMIT of EXPLAIN ANALYZE. */
  limit?: number;
}

/** Suggested index keys as a SQL column list: `status, created_at DESC`. */
function sqlColumns(keys: Doc): string {
  return Object.entries(keys)
    .map(([col, dir]) => `${sqlIdent(col)}${dir === -1 ? " DESC" : ""}`)
    .join(", ");
}

const fmtMs = (ms: number | null | undefined) =>
  ms === null || ms === undefined ? null : `${ms >= 100 ? Math.round(ms) : ms.toFixed(2)} ms`;

interface ExplainSheetProps {
  request: ExplainRequest | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ExplainSheet({ request, open, onOpenChange }: ExplainSheetProps) {
  const [summary, setSummary] = useState<ExplainSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [showRaw, setShowRaw] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createdIndex, setCreatedIndex] = useState<string | null>(null);
  const aiReady = useAi((st) => st.configured);
  const engine = useEngine();
  const pg = engine === "postgres";
  const [reading, setReading] = useState<{ busy: boolean; notes?: string; usage?: string } | null>(null);

  const askAi = async () => {
    if (!request || !summary) return;
    if (!aiReady) {
      toast.error(AI_NOT_READY);
      return;
    }
    setReading({ busy: true });
    try {
      const { raw, ...rest } = summary;
      const { notes, usage } = await interpretExplain({
        engine,
        database: request.database,
        collection: request.collection,
        summary: rest,
        raw,
      });
      setReading({ busy: false, notes, usage: formatUsage(usage) });
    } catch (e) {
      setReading(null);
      toast.error(errMsg(e));
    }
  };

  const createSuggested = async () => {
    if (!request || !summary?.suggestedIndex) return;
    setCreating(true);
    try {
      const name = await api.createIndex({
        database: request.database,
        collection: request.collection,
        keysText: pg ? sqlColumns(summary.suggestedIndex) : JSON.stringify(summary.suggestedIndex),
        unique: false,
      });
      setCreatedIndex(name);
      toast.success(`Index "${name}" created - re-run the query to use it`);
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setCreating(false);
    }
  };

  useEffect(() => {
    if (!open || !request) return;
    setSummary(null);
    setError(null);
    setShowRaw(false);
    setCreatedIndex(null);
    setReading(null);
    setLoading(true);
    api
      .explainQuery({ verbosity: "executionStats", ...request, limit: request.limit })
      .then(setSummary)
      .catch((e) => setError(errMsg(e)))
      .finally(() => setLoading(false));
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const ratio =
    summary && summary.nReturned && summary.totalDocsExamined
      ? summary.totalDocsExamined / Math.max(1, summary.nReturned)
      : null;
  // A scan that reads far more docs than it returns is the classic red flag.
  const inefficient = summary?.isCollectionScan || (ratio !== null && ratio > 10);
  const rows = pg ? "rows" : "documents";
  // Postgres: the summary rounds execution time; the raw plan keeps the decimals.
  const execMs = pg && typeof summary?.raw["Execution Time"] === "number" ? (summary.raw["Execution Time"] as number) : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={pg ? "max-w-[760px]" : "max-w-[640px]"}>
        <DialogHeader>
          <DialogTitle>Explain plan</DialogTitle>
          <DialogDescription>
            {request?.database}.{request?.collection}
            {pg ? " · select" : request?.pipelineStages ? " · aggregate" : " · find"}
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          {loading ? (
            <div className="flex justify-center py-10">
              <Loader2 className="spin h-5 w-5 text-text-3" />
            </div>
          ) : error ? (
            <div className="notice dgr mono">
              <span className="break-all">{error}</span>
            </div>
          ) : summary ? (
            <>
              <div className={cn("warnbox", inefficient ? "soft" : "ok")}>
                {inefficient ? <AlertTriangle /> : <CheckCircle2 />}
                <div>
                  {summary.isCollectionScan && pg ? (
                    <b>Seq Scan - the table is read row by row{summary.indexName ? "" : "; no index used"}.</b>
                  ) : summary.isCollectionScan ? (
                    <b>Collection scan - no index used. Every document is read.</b>
                  ) : (
                    <>
                      <b>Index used:</b> <span className="mono">{summary.indexName ?? "-"}</span>
                    </>
                  )}
                  {ratio !== null && (
                    <div className="mt-1 text-text-3">
                      {pg ? "Scanned" : "Examined"} {ratio.toFixed(1)}x the {rows} returned
                      {inefficient && !summary.isCollectionScan ? " - consider a more selective index." : "."}
                    </div>
                  )}
                </div>
              </div>

              <div className={cn("statgrid", pg && "five")}>
                {(pg
                  ? ([
                      ["Returned", summary.nReturned],
                      ["Rows scanned", summary.totalDocsExamined],
                      ["Est. cost", summary.totalCost == null ? null : summary.totalCost.toFixed(2)],
                      ["Planning", fmtMs(summary.planningTimeMillis)],
                      ["Execution", fmtMs(execMs ?? summary.executionTimeMillis)],
                    ] as const)
                  : ([
                      ["Returned", summary.nReturned],
                      ["Docs examined", summary.totalDocsExamined],
                      ["Keys examined", summary.totalKeysExamined],
                      ["Time", summary.executionTimeMillis === null ? null : `${summary.executionTimeMillis} ms`],
                    ] as const)
                ).map(([label, value]) => (
                  <div key={label}>
                    <div className="l">{label}</div>
                    <div className="v">
                      {value === null || value === undefined ? "-" : typeof value === "number" ? formatCount(value) : value}
                    </div>
                  </div>
                ))}
              </div>

              {summary.isCollectionScan && summary.suggestedIndex && (
                <div className="idxrow acc">
                  <span className="pill acc">suggested</span>
                  <div className="min-w-0 flex-1">
                    <div className="n">
                      {pg ? `(${sqlColumns(summary.suggestedIndex)})` : JSON.stringify(summary.suggestedIndex)}
                    </div>
                    <div className="mt-1 text-[10.5px] text-text-3">
                      {pg
                        ? "Equality, sort, range column order - derived from this query's WHERE and ORDER BY."
                        : "Equality, sort, range field order - derived from this query's shape."}
                    </div>
                  </div>
                  <div className="r">
                    {createdIndex ? (
                      <span className="pill ok">
                        <CheckCircle2 /> created
                      </span>
                    ) : (
                      <Button size="sm" disabled={creating} onClick={() => void createSuggested()}>
                        {creating && <Loader2 className="spin" />}
                        Create index
                      </Button>
                    )}
                  </div>
                </div>
              )}

              {pg && (
                <div className="fld">
                  <label>Plan</label>
                  <PgPlanTree raw={summary.raw} />
                </div>
              )}

              {!pg && summary.stages.length > 0 && (
                <div className="fld">
                  <label>Plan stages</label>
                  <div className="flex flex-wrap items-center gap-1.5">
                    {summary.stages.map((st, i) => (
                      <span key={i} className="flex items-center gap-1.5">
                        {i > 0 && <span className="text-text-3">‹</span>}
                        <span className={cn("pill", st === "COLLSCAN" && "warn")}>{st}</span>
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {reading?.notes ? (
                <div className="notice acc">
                  <Sparkles />
                  <div className="min-w-0 flex-1">
                    <p className="whitespace-pre-wrap text-[12px] leading-relaxed text-text-2">{reading.notes}</p>
                    <p className="mt-1.5 font-mono text-[10.5px] text-text-3">{reading.usage}</p>
                  </div>
                </div>
              ) : (
                <Button variant="outline" size="sm" className="self-start" disabled={reading?.busy} onClick={() => void askAi()}>
                  {reading?.busy ? <Loader2 className="spin" /> : <Sparkles />}
                  Ask AI to read this plan
                </Button>
              )}

              <button
                onClick={() => setShowRaw((v) => !v)}
                className="self-start text-[11.5px] text-text-3 underline-offset-2 hover:text-text hover:underline"
              >
                {showRaw ? "Hide" : "Show"} raw plan
              </button>
              {showRaw && (
                <pre className="mono max-h-72 overflow-auto rounded-[var(--r-sm)] border border-line bg-panel-2 p-3 text-[11px] leading-relaxed">
                  {JSON.stringify(summary.raw, null, 2)}
                </pre>
              )}
            </>
          ) : null}
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
