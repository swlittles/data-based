import { useState } from "react";
import { toast } from "sonner";
import { Check, Loader2, Sparkles, X } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { api, errMsg } from "@/lib/api";
import { assistActions, assistQuery, formatUsage, shortType, type AssistResult } from "@/lib/ai";
import { AI_NOT_READY, useAi } from "@/stores/ai";
import { useEngine } from "@/stores/connections";
import { useUi } from "@/stores/ui";

export interface AssistState {
  label: string;
  busy: boolean;
  result: AssistResult | null;
}

/**
 * AI help for a mongosh statement (or SQL in a PostgreSQL workspace): a
 * toolbar menu plus the result panel. The owner keeps the state so the menu
 * and panel can live in different places.
 */
export function useQueryAssist(args: {
  database: string;
  collection: string;
  getQuery: () => string;
  getError: () => string | null;
}) {
  const configured = useAi((s) => s.configured);
  const engine = useEngine();
  const ui = useUi((s) => s.set);
  const [state, setState] = useState<AssistState | null>(null);

  const run = async (label: string, instruction: string) => {
    if (!configured) {
      toast.error(AI_NOT_READY, { action: { label: "Settings", onClick: () => ui({ settings: true }) } });
      return;
    }
    const query = args.getQuery().trim();
    if (!query) {
      toast.error("Write a statement first");
      return;
    }
    setState({ label, busy: true, result: null });
    try {
      // Postgres: typed columns (and the key) say more than bare names.
      const fields =
        engine === "postgres"
          ? await api
              .tableMeta(args.database, args.collection)
              .then((m) =>
                m.columns.map((c) => `${c.name} ${shortType(c.dataType)}${m.primaryKey.includes(c.name) ? " PK" : ""}`)
              )
              .catch(() => [])
          : await api.collectionFields(args.database, args.collection, 200).catch(() => []);
      const result = await assistQuery({
        engine,
        query,
        instruction,
        database: args.database,
        collection: args.collection,
        fields,
        error: args.getError(),
      });
      setState({ label, busy: false, result });
    } catch (e) {
      setState(null);
      toast.error(errMsg(e));
    }
  };

  return { state, run, dismiss: () => setState(null) };
}

export function AssistMenu({ busy, onPick }: { busy: boolean; onPick: (label: string, instruction: string) => void }) {
  const [custom, setCustom] = useState("");
  const engine = useEngine();
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <button className="btn qt sm" disabled={busy}>
          {busy ? <Loader2 className="spin" /> : <Sparkles />}
          AI
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-80">
        <DropdownMenuLabel className="text-xs">
          Ask AI about this {engine === "postgres" ? "SQL" : "statement"}
        </DropdownMenuLabel>
        {assistActions(engine).map((a) => (
          <DropdownMenuItem key={a.id} className="gap-2.5 py-2" onClick={() => onPick(a.label, a.instruction)}>
            <span className="w-28 text-[12px] text-text">{a.label}</span>
            <span className="text-[11px] text-text-3">{a.hint}</span>
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <form
          className="p-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            if (!custom.trim()) return;
            onPick("Custom request", custom.trim());
            setCustom("");
          }}
        >
          <input
            value={custom}
            onChange={(e) => setCustom(e.target.value)}
            onKeyDown={(e) => e.stopPropagation()}
            placeholder="Or describe a change, then Enter"
            className="h-8 w-full rounded-[var(--r-sm)] border border-line bg-panel-2 px-2.5 text-[12px] text-text outline-none placeholder:text-text-3 focus:border-accent-line"
          />
        </form>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function AssistPanel({
  state,
  onApply,
  onDismiss,
}: {
  state: AssistState;
  onApply: (query: string) => void;
  onDismiss: () => void;
}) {
  const r = state.result;
  return (
    <div className="mx-[var(--pad)] mb-2 shrink-0 rounded-[var(--r-sm)] border border-accent-line bg-accent-soft">
      <div className="flex items-center gap-2 px-3 py-2">
        {state.busy ? <Loader2 className="spin h-3.5 w-3.5 text-primary" /> : <Sparkles className="h-3.5 w-3.5 text-primary" />}
        <span className="text-[12px] font-medium text-text">{state.label}</span>
        {r && <span className="font-mono text-[10.5px] text-text-3">{formatUsage(r.usage)}</span>}
        <div className="flex-1" />
        {r?.query && (
          <button className="btn pri sm" onClick={() => onApply(r.query!)}>
            <Check />
            Apply
          </button>
        )}
        <button className="btn qt sm" onClick={onDismiss} aria-label="Dismiss">
          <X />
        </button>
      </div>
      {r && (
        <div className="flex max-h-[280px] flex-col gap-2 overflow-y-auto border-t border-accent-line px-3 py-2.5">
          {r.notes && <p className="whitespace-pre-wrap text-[12px] leading-relaxed text-text-2">{r.notes}</p>}
          {r.query && (
            <pre className="mono overflow-x-auto rounded-[var(--r-xs)] border border-line bg-panel px-2.5 py-2 text-[11.5px] leading-relaxed text-text">
              {r.query}
            </pre>
          )}
          {!r.query && !r.notes && <p className="text-[12px] text-text-3">No changes suggested.</p>}
        </div>
      )}
    </div>
  );
}
