import { memo, useMemo, useState } from "react";
import { toast } from "sonner";
import { save } from "@tauri-apps/plugin-dialog";
import {
  AlertCircle,
  BarChart3,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  Download,
  FileJson2,
  Loader2,
  Lock,
  MessageSquareText,
  Pin,
  RotateCcw,
  Table2,
  Terminal,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Chart, ChartKindToggle } from "@/components/studio/Chart";
import { ResultsViewer } from "@/components/explorer/ResultsViewer";
import { api, errMsg, type Doc } from "@/lib/api";
import { addUsage, formatUsage, summarizeResults, type ChartKind } from "@/lib/ai";
import { chartFromDocs, docsToCsv } from "@/lib/studio";
import { useAi } from "@/stores/ai";
import type { ChatTurn } from "@/stores/chat";
import { cn } from "@/lib/utils";

type ResultView = "chart" | "table" | "json";

async function exportRows(docs: Doc[], format: "csv" | "json", name: string) {
  const path = await save({
    title: "Export results",
    defaultPath: `${name}.${format}`,
    filters: [{ name: format.toUpperCase(), extensions: [format] }],
  }).catch(() => null);
  if (!path) return;
  try {
    await api.saveTextFile(path, format === "csv" ? docsToCsv(docs) : JSON.stringify(docs, null, 2));
    toast.success(`Exported ${docs.length} row${docs.length === 1 ? "" : "s"}`);
  } catch (e) {
    toast.error(errMsg(e));
  }
}

export function UserBubble({ text, pinned, onPin }: { text: string; pinned: boolean; onPin: () => void }) {
  return (
    <div className="group flex justify-end gap-2">
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            onClick={onPin}
            disabled={pinned}
            aria-label={pinned ? "Saved" : "Save this question"}
            className={cn(
              "mt-1.5 grid h-6 w-6 shrink-0 place-items-center rounded-[var(--r-xs)] text-text-3 transition-opacity hover:bg-hover hover:text-text",
              pinned ? "text-primary opacity-100" : "opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
            )}
          >
            {pinned ? <Check className="h-3.5 w-3.5" /> : <Pin className="h-3.5 w-3.5" />}
          </button>
        </TooltipTrigger>
        <TooltipContent>{pinned ? "Saved question" : "Save question - rerun it any time"}</TooltipContent>
      </Tooltip>
      <div className="max-w-[78%] whitespace-pre-wrap rounded-[var(--r)] rounded-tr-[var(--r-xs)] border border-accent-line bg-accent-soft px-3.5 py-2.5 text-[13px] leading-relaxed text-text">
        {text}
      </div>
    </div>
  );
}

interface AssistantTurnProps {
  turn: ChatTurn;
  prompt: string;
  onPatch: (patch: Partial<ChatTurn>) => void;
  onRetry: () => void;
  onOpenShell: (query: string, collection: string) => void;
  onViewDoc: (doc: Doc) => void;
}

export const AssistantTurn = memo(function AssistantTurn({
  turn,
  prompt,
  onPatch,
  onRetry,
  onOpenShell,
  onViewDoc,
}: AssistantTurnProps) {
  const shareSamples = useAi((s) => s.shareSamples);
  const [showQuery, setShowQuery] = useState(false);
  const [copied, setCopied] = useState(false);
  const [summarizing, setSummarizing] = useState(false);
  const docs = turn.docs ?? [];
  const kind: ChartKind = turn.chartType ?? turn.plan?.chart?.type ?? "bar";
  const chart = useMemo(() => (turn.plan ? chartFromDocs(docs, turn.plan, kind) : null), [docs, turn.plan, kind]);
  // null = automatic: the chart when the plan has one, else the table. Chosen
  // after the turn resolves, so a pending turn does not pin the table view.
  const [picked, setView] = useState<ResultView | null>(null);
  const view: ResultView = picked === "chart" && !chart ? "table" : picked ?? (chart ? "chart" : "table");
  const actions = useMemo(() => ({ onView: onViewDoc }), [onViewDoc]);

  if (turn.pending) {
    return (
      <div className="flex items-center gap-2.5 py-1 text-[12.5px] text-text-3" role="status">
        <Loader2 className="spin h-3.5 w-3.5 text-primary" />
        {turn.status ?? "Thinking"}
      </div>
    );
  }

  if (turn.error) {
    return (
      <div className="notice dgr items-center">
        <AlertCircle />
        <span className="min-w-0 flex-1 break-words">{turn.error}</span>
        <button className="btn qt sm" onClick={onRetry}>
          <RotateCcw />
          Try again
        </button>
      </div>
    );
  }

  if (turn.blocked) {
    return (
      <div className="warnbox soft">
        <Lock />
        <div>
          <b>Studio is read-only.</b>{" "}
          <span className="text-text-2">
            It answers questions about your data but never changes it. To insert, update or delete, use the
            collection views or the shell, where writes are guarded by the workspace's edit mode.
          </span>
        </div>
      </div>
    );
  }

  const summarize = async () => {
    setSummarizing(true);
    try {
      const { summary, usage } = await summarizeResults(prompt, docs);
      onPatch({ summary, usage: turn.usage ? addUsage(turn.usage, usage) : usage });
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setSummarizing(false);
    }
  };

  const copyQuery = () => {
    if (!turn.query) return;
    void navigator.clipboard.writeText(turn.query);
    setCopied(true);
    setTimeout(() => setCopied(false), 1400);
  };

  const exportName = `${turn.runCollection ?? "results"}-studio`;

  return (
    <div className="flex flex-col gap-3">
      {turn.plan?.explanation && <p className="text-[13px] leading-relaxed text-text">{turn.plan.explanation}</p>}

      {turn.query && (
        <div className="rounded-[var(--r-sm)] border border-line bg-panel">
          <div className="flex items-center gap-1 px-1.5 py-1">
            <button
              className="btn qt sm"
              onClick={() => setShowQuery((v) => !v)}
              aria-expanded={showQuery}
            >
              {showQuery ? <ChevronDown /> : <ChevronRight />}
              Query
            </button>
            <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-text-3">
              {turn.runCollection} · {turn.plan?.kind}
            </span>
            <button className="btn qt sm" onClick={copyQuery} aria-label="Copy query">
              {copied ? <Check /> : <Copy />}
            </button>
            <button className="btn qt sm" onClick={() => onOpenShell(turn.query!, turn.runCollection ?? "")}>
              <Terminal />
              Open in Shell
            </button>
          </div>
          {showQuery && (
            <pre className="mono max-h-72 overflow-auto border-t border-line bg-panel-2 px-3 py-2.5 text-[11.5px] leading-relaxed text-text-2">
              {turn.query}
            </pre>
          )}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <div className="seg no-select" role="tablist" aria-label="Result view">
          <button className={cn(view === "chart" && "on")} disabled={!chart} onClick={() => setView("chart")}>
            <BarChart3 />
            Chart
          </button>
          <button className={cn(view === "table" && "on")} onClick={() => setView("table")}>
            <Table2 />
            Table
          </button>
          <button className={cn(view === "json" && "on")} onClick={() => setView("json")}>
            <FileJson2 />
            Documents
          </button>
        </div>
        {view === "chart" && chart && <ChartKindToggle value={kind} onChange={(k) => onPatch({ chartType: k })} />}
        <span className="font-mono text-[11px] text-text-3">
          {turn.docCount ?? docs.length} row{(turn.docCount ?? docs.length) === 1 ? "" : "s"}
          {turn.execMs !== undefined && ` · ${turn.execMs}ms`}
        </span>
        <div className="flex-1" />
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger asChild>
            <button className="btn qt sm" disabled={docs.length === 0}>
              <Download />
              Export
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={() => void exportRows(docs, "csv", exportName)}>CSV</DropdownMenuItem>
            <DropdownMenuItem onClick={() => void exportRows(docs, "json", exportName)}>JSON</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <Tooltip>
          <TooltipTrigger asChild>
            <span>
              <button
                className="btn qt sm"
                disabled={summarizing || docs.length === 0 || !shareSamples || !!turn.summary}
                onClick={() => void summarize()}
              >
                {summarizing ? <Loader2 className="spin" /> : <MessageSquareText />}
                Summarize
              </button>
            </span>
          </TooltipTrigger>
          <TooltipContent>
            {shareSamples ? "Plain-language reading of these rows" : "Turn on sharing sample data in Settings > AI to summarize results"}
          </TooltipContent>
        </Tooltip>
      </div>

      {turn.summary && (
        <div className="notice acc">
          <MessageSquareText />
          <span className="whitespace-pre-wrap">{turn.summary}</span>
        </div>
      )}

      {docs.length === 0 ? (
        <div className="notice">No rows matched.</div>
      ) : view === "chart" && chart ? (
        <div className="rounded-[var(--r)] border border-line bg-panel p-4">
          <Chart data={chart} />
        </div>
      ) : (
        <div className="flex max-h-[420px] min-h-[160px] flex-col overflow-hidden rounded-[var(--r)] border border-line bg-panel">
          <ResultsViewer docs={docs} view={view === "json" ? "json" : "table"} actions={actions} emptyText="No rows" />
        </div>
      )}

      {turn.usage && (
        <div className="font-mono text-[10.5px] text-text-3">
          {turn.model ? `${turn.model} · ` : ""}
          {formatUsage(turn.usage)}
        </div>
      )}
    </div>
  );
});
