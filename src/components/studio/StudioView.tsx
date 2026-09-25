import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
  ArrowUp,
  History,
  KeyRound,
  Layers,
  Lightbulb,
  Loader2,
  PanelLeftClose,
  Plus,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Blank } from "@/components/layout/Blank";
import { ValueTree } from "@/components/explorer/ValueTree";
import { AssistantTurn, UserBubble } from "@/components/studio/StudioTurn";
import { api, errMsg, type Doc } from "@/lib/api";
import {
  addUsage,
  findLimit,
  formatUsage,
  generateVizPlan,
  planToShell,
  selectCollections,
  suggestPrompts,
  ZERO_USAGE,
  type DbSchema,
  type TokenUsage,
  type VizHistoryItem,
} from "@/lib/ai";
import { relTime } from "@/lib/studio";
import { AI_MODE_META, useAi, type AiMode } from "@/stores/ai";
import { useChat, WHOLE_DB, type ChatSession, type ChatTurn } from "@/stores/chat";
import { sameInsight, useInsights, type Insight } from "@/stores/insights";
import { useConnections } from "@/stores/connections";
import { useExplorer } from "@/stores/explorer";
import { useSettings } from "@/stores/settings";
import { useUi } from "@/stores/ui";
import { cn } from "@/lib/utils";

const STARTERS_SINGLE = [
  "Count documents grouped by status",
  "Documents created per day over the last 30 days",
  "Top 10 most recent documents",
];
const STARTERS_MULTI = ["Orders per customer, top 10", "Total revenue by product category", "Users with no orders yet"];

/** Prior user prompts and the queries they produced, for follow-up context. */
function buildHistory(turns: ChatTurn[]): VizHistoryItem[] {
  const out: VizHistoryItem[] = [];
  turns.forEach((t, i) => {
    if (t.role !== "user" || !t.text) return;
    const next = turns[i + 1];
    out.push({ prompt: t.text, query: next?.role === "assistant" ? next.query : undefined });
  });
  return out;
}

/** Profile id (or workspace id for ad-hoc) that chats and insights belong to. */
function useConnectionKey(): string {
  return useConnections((s) => {
    const ws = s.workspaces.find((w) => w.info.id === s.activeId);
    return ws?.info.profileId ?? ws?.info.id ?? "adhoc";
  });
}

/**
 * Studio: ask a question in plain language, get a read-only query, its rows
 * and a chart. Scope is one collection, or the whole database (the model picks
 * collections and joins them). Chats and saved questions are per connection.
 */
export function StudioView() {
  const connection = useConnectionKey();
  const databases = useExplorer((s) => s.databases);
  const collections = useExplorer((s) => s.collections);
  const selectedDb = useExplorer((s) => s.selectedDb);
  const activeTab = useExplorer((s) => s.tabs.find((t) => t.id === s.activeTabId));
  const loadDatabases = useExplorer((s) => s.loadDatabases);
  const loadCollections = useExplorer((s) => s.loadCollections);
  const openShellWithQuery = useExplorer((s) => s.openShellWithQuery);
  const setAdvancedMode = useSettings((s) => s.setAdvancedMode);
  const ui = useUi((s) => s.set);
  const { configured, mode, setMode, shareSamples, model } = useAi();

  const { sessions, activeId, newSession, setActive, addTurn, patchTurn, deleteSession, clearConnection } = useChat();
  const insights = useInsights((s) => s.insights);
  const addInsight = useInsights((s) => s.addInsight);
  const removeInsight = useInsights((s) => s.removeInsight);

  const [database, setDatabase] = useState(activeTab?.database ?? selectedDb ?? "");
  const [scope, setScope] = useState(activeTab?.collection ?? (selectedDb ? WHOLE_DB : ""));
  const [fields, setFields] = useState<string[]>([]);
  /** "db/collection" whose fields finished loading (even when empty). */
  const [fieldsFor, setFieldsFor] = useState("");
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [sideOpen, setSideOpen] = useState(true);
  const [suggestions, setSuggestions] = useState<string[] | null>(null);
  const [suggesting, setSuggesting] = useState(false);
  const [newTopicHint, setNewTopicHint] = useState(false);
  const [viewDoc, setViewDoc] = useState<Doc | null>(null);
  /** Saved question waiting for its scope to load before it is asked. */
  const [pendingInsight, setPendingInsight] = useState<string | null>(null);
  const fieldCache = useRef<Record<string, string[]>>({});
  const docCache = useRef<Record<string, unknown>>({});
  const transcriptEnd = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const multi = scope === WHOLE_DB;
  const mine = useMemo(() => sessions.filter((s) => s.connection === connection), [sessions, connection]);
  const active = mine.find((s) => s.id === activeId) ?? null;
  const current = active && active.database === database && active.scope === scope ? active : null;
  const turns = current?.turns ?? [];
  const myInsights = insights.filter((i) => i.connection === connection);

  useEffect(() => {
    if (databases.length === 0) void loadDatabases();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!database && databases.length) setDatabase(databases[0].name);
  }, [databases, database]);

  useEffect(() => {
    if (database && !collections[database]) void loadCollections(database);
  }, [database]); // eslint-disable-line react-hooks/exhaustive-deps

  // A different scope starts a blank canvas; its chats stay in the side list.
  useEffect(() => {
    if (active && (active.database !== database || active.scope !== scope)) setActive(null);
    setSuggestions(null);
    setNewTopicHint(false);
  }, [database, scope]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    setFields([]);
    if (!database || !scope || multi) return;
    const key = `${database}/${scope}`;
    api
      .collectionFields(database, scope, 1000)
      .then(setFields)
      .catch(() => {})
      .finally(() => setFieldsFor(key));
  }, [database, scope, multi]);

  useEffect(() => {
    transcriptEnd.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [turns.length, turns[turns.length - 1]?.pending]);

  const colls = collections[database] ?? [];
  const ready = Boolean(database && scope);

  const collectionNames = async () => {
    const list = collections[database] ?? (await loadCollections(database));
    return list.filter((c) => c.kind !== "view").map((c) => c.name);
  };

  const sampleFields = async (names: string[]): Promise<DbSchema> => {
    const schema: DbSchema = {};
    await Promise.all(
      names.map(async (name) => {
        const key = `${database}/${name}`;
        if (!fieldCache.current[key]) {
          fieldCache.current[key] = await api
            .collectionFields(database, name, 200)
            .then((f) => f.slice(0, 50))
            .catch(() => []);
        }
        schema[name] = fieldCache.current[key];
      })
    );
    return schema;
  };

  const sampleDoc = async (name: string) => {
    const key = `${database}/${name}`;
    if (!(key in docCache.current)) {
      docCache.current[key] = await api
        .findDocuments({ database, collection: name, filter: "{}", sort: "", projection: "", limit: 1, skip: 0 })
        .then((p) => p.docs[0] ?? null)
        .catch(() => null);
    }
    return docCache.current[key];
  };

  /** Whole database: sample every collection's fields, let the model pick the
   *  relevant ones (bridges included), then attach one sample doc each. */
  const resolveSchema = async (prompt: string) => {
    const names = await collectionNames();
    if (names.length === 0) throw new Error(`${database} has no collections to query`);
    const full = await sampleFields(names.slice(0, 80));
    const picked = await selectCollections({ prompt, database, schema: full });
    const chosen = picked.collections.length ? picked.collections : names.slice(0, 6);
    const schema: DbSchema = {};
    const samples: Record<string, unknown> = {};
    await Promise.all(
      chosen.map(async (n) => {
        schema[n] = full[n] ?? [];
        if (shareSamples) {
          const doc = await sampleDoc(n);
          if (doc) samples[n] = doc;
        }
      })
    );
    return { schema, samples, usage: picked.usage };
  };

  const ask = async (raw: string, forceNew = false) => {
    const prompt = raw.trim();
    if (!prompt || busy || !ready) return;
    const existing = !forceNew ? current : null;
    const history = existing ? buildHistory(existing.turns) : [];
    const sid = existing ? existing.id : newSession(connection, database, scope, prompt);
    addTurn(sid, { role: "user", text: prompt });
    const aid = addTurn(sid, { role: "assistant", pending: true, status: multi ? "Reading the database" : "Writing the query" });
    setDraft("");
    setSuggestions(null);
    setNewTopicHint(false);
    setBusy(true);
    let usage: TokenUsage = ZERO_USAGE;
    try {
      let schema: DbSchema | undefined;
      let samples: Record<string, unknown> | undefined;
      if (multi) {
        const resolved = await resolveSchema(prompt);
        ({ schema, samples } = resolved);
        usage = addUsage(usage, resolved.usage);
        patchTurn(sid, aid, { status: `Writing a query across ${Object.keys(schema).join(", ")}` });
      }
      const { plan, usage: planUsage } = await generateVizPlan({
        prompt,
        database,
        collection: multi ? undefined : scope,
        fields: multi ? undefined : fields,
        schema,
        samples,
        history,
      });
      usage = addUsage(usage, planUsage);
      if (plan.writeIntent) {
        patchTurn(sid, aid, { pending: false, status: undefined, blocked: true, plan, usage, model });
        return;
      }
      const runCollection = multi ? plan.collection! : scope;
      patchTurn(sid, aid, { status: `Running on ${runCollection}` });
      const page =
        plan.kind === "aggregate"
          ? // readOnly: the backend rejects $out / $merge on this path no matter what the model wrote.
            await api.aggregate(database, runCollection, plan.stages!, false, true)
          : await api.findDocuments({
              database,
              collection: runCollection,
              filter: plan.filter || "{}",
              sort: plan.sort ?? "",
              projection: plan.projection ?? "",
              limit: findLimit(plan),
              skip: 0,
            });
      patchTurn(sid, aid, {
        pending: false,
        status: undefined,
        plan,
        query: planToShell(plan, runCollection),
        runCollection,
        docs: page.docs,
        docCount: page.docs.length,
        execMs: page.execMs,
        chartType: plan.chart?.type ?? null,
        usage,
        model,
      });
      if (history.length > 0 && plan.unrelatedToConversation) setNewTopicHint(true);
    } catch (e) {
      patchTurn(sid, aid, { pending: false, status: undefined, error: errMsg(e), usage: usage.total ? usage : undefined });
    } finally {
      setBusy(false);
      inputRef.current?.focus();
    }
  };

  const loadSuggestions = async () => {
    setSuggesting(true);
    try {
      const res = multi
        ? await suggestPrompts({ database, schema: await sampleFields((await collectionNames()).slice(0, 15)) })
        : await suggestPrompts({ database, collection: scope, fields });
      setSuggestions(res.prompts);
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setSuggesting(false);
    }
  };

  // Activating in the same batch as the scope change means the scope effect
  // sees a matching session and keeps it.
  const openSession = (s: ChatSession) => {
    setDatabase(s.database);
    setScope(s.scope);
    setActive(s.id);
  };

  const runInsight = (i: Insight) => {
    const sameScope = i.database === database && i.scope === scope;
    setDatabase(i.database);
    setScope(i.scope);
    setActive(null);
    if (sameScope) void ask(i.prompt, true);
    else setPendingInsight(i.prompt);
  };
  // An insight for another scope waits for the scope's fields to load.
  useEffect(() => {
    if (!pendingInsight || busy || !ready) return;
    if (!multi && fieldsFor !== `${database}/${scope}`) return;
    const p = pendingInsight;
    setPendingInsight(null);
    void ask(p, true);
  }, [pendingInsight, fieldsFor, ready, multi]); // eslint-disable-line react-hooks/exhaustive-deps

  const openShell = useCallback(
    (query: string, collection: string) => {
      setAdvancedMode(true);
      openShellWithQuery(database, collection, query);
      ui({ studio: false });
    },
    [database, openShellWithQuery, setAdvancedMode, ui]
  );

  const sessionUsage = turns.reduce((acc, t) => (t.usage ? addUsage(acc, t.usage) : acc), ZERO_USAGE);
  const scopeLabel = multi ? "the whole database" : scope;

  if (!configured) {
    return (
      <main className="canvas">
        <Blank
          title="Connect OpenRouter to use Studio"
          text="Studio turns plain-English questions into read-only queries and charts. It uses your own OpenRouter key, stored encrypted like your database passwords."
          actions={
            <button className="btn pri" onClick={() => ui({ settings: true })}>
              <KeyRound />
              Add API key
            </button>
          }
        />
      </main>
    );
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1">
      {sideOpen && (
        <aside className="pick" aria-label="Saved questions and recent chats">
          <div className="ph">
            <button className="btn sm flex-1 justify-center" onClick={() => setActive(null)}>
              <Plus />
              New chat
            </button>
            <Tooltip>
              <TooltipTrigger asChild>
                <button className="btn qt sm" onClick={() => setSideOpen(false)} aria-label="Hide side panel">
                  <PanelLeftClose />
                </button>
              </TooltipTrigger>
              <TooltipContent>Hide</TooltipContent>
            </Tooltip>
          </div>
          <div className="list">
            <div className="pgh">Saved questions</div>
            {myInsights.length === 0 && (
              <p className="px-2.5 pb-2 text-[11.5px] leading-snug text-text-3">
                Hover a question you asked and pin it to rerun it later against fresh data.
              </p>
            )}
            {myInsights.map((i) => (
              <div key={i.id} className="it group" title={i.prompt}>
                <button className="flex min-w-0 flex-1 items-center gap-2 text-left" onClick={() => runInsight(i)} disabled={busy}>
                  <Lightbulb className="text-primary" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[12px] text-text">{i.prompt}</span>
                    <span className="block truncate font-mono text-[10px] text-text-3">
                      {i.database}
                      {i.scope === WHOLE_DB ? " · all" : `.${i.scope}`}
                    </span>
                  </span>
                </button>
                <button className="x" onClick={() => removeInsight(i.id)} aria-label="Remove saved question">
                  <X />
                </button>
              </div>
            ))}

            <div className="pgh mt-2 flex items-center">
              Recent chats
              {mine.length > 0 && (
                <button
                  className="ml-auto normal-case tracking-normal text-text-3 hover:text-text"
                  onClick={() => clearConnection(connection)}
                  aria-label="Clear chats for this connection"
                >
                  <Trash2 className="h-3 w-3" />
                </button>
              )}
            </div>
            {mine.length === 0 && <p className="px-2.5 text-[11.5px] text-text-3">No chats yet</p>}
            {mine.map((s) => (
              <div key={s.id} className={cn("it group", current?.id === s.id && "on")} title={s.title}>
                <button className="flex min-w-0 flex-1 items-center gap-2 text-left" onClick={() => openSession(s)}>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[12px]">{s.title}</span>
                    <span className="block truncate font-mono text-[10px] text-text-3">
                      {s.scope === WHOLE_DB ? s.database : `${s.database}.${s.scope}`} · {relTime(s.updatedAt)}
                    </span>
                  </span>
                </button>
                <button className="x" onClick={() => deleteSession(s.id)} aria-label="Delete chat">
                  <X />
                </button>
              </div>
            ))}
          </div>
        </aside>
      )}

      <main className="canvas">
        <div className="viewrow no-select">
          {!sideOpen && (
            <Tooltip>
              <TooltipTrigger asChild>
                <button className="btn qt sm" onClick={() => setSideOpen(true)} aria-label="Show saved questions and chats">
                  <History />
                </button>
              </TooltipTrigger>
              <TooltipContent>Saved questions and chats</TooltipContent>
            </Tooltip>
          )}
          <span className="pill acc">
            <Sparkles />
            Studio
          </span>
          <Select
            value={database}
            onValueChange={(v) => {
              setDatabase(v);
              setScope(WHOLE_DB);
            }}
          >
            <SelectTrigger className="h-8 w-[170px] text-xs" aria-label="Database">
              <SelectValue placeholder="Database" />
            </SelectTrigger>
            <SelectContent>
              {databases.map((d) => (
                <SelectItem key={d.name} value={d.name}>
                  {d.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={scope} onValueChange={setScope} disabled={!database}>
            <SelectTrigger className="h-8 w-[210px] text-xs" aria-label="Collection">
              <SelectValue placeholder="Collection" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={WHOLE_DB}>
                <span className="flex items-center gap-1.5">
                  <Layers className="h-3.5 w-3.5 text-primary" />
                  Whole database (joins)
                </span>
              </SelectItem>
              {colls.length > 0 && <SelectSeparator />}
              {colls.map((c) => (
                <SelectItem key={c.name} value={c.name}>
                  {c.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <div className="r">
            <div className="seg" role="radiogroup" aria-label="AI mode">
              {(Object.keys(AI_MODE_META) as AiMode[]).map((m) => (
                <Tooltip key={m}>
                  <TooltipTrigger asChild>
                    <button role="radio" aria-checked={mode === m} className={cn(mode === m && "on")} onClick={() => setMode(m)}>
                      {AI_MODE_META[m].label}
                    </button>
                  </TooltipTrigger>
                  <TooltipContent>{AI_MODE_META[m].hint}</TooltipContent>
                </Tooltip>
              ))}
            </div>
            <Tooltip>
              <TooltipTrigger asChild>
                <button className="btn qt sm" onClick={() => ui({ studio: false })} aria-label="Close Studio">
                  <X />
                </button>
              </TooltipTrigger>
              <TooltipContent>Back to the explorer</TooltipContent>
            </Tooltip>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {turns.length === 0 ? (
            <div className="mx-auto flex h-full max-w-[640px] flex-col items-center justify-center gap-5 px-6 text-center">
              <div>
                <h2 className="font-display text-[26px] font-semibold tracking-[-0.02em] text-text">
                  {ready ? `Ask about ${scopeLabel}` : "Pick a database to start"}
                </h2>
                <p className="mx-auto mt-2 max-w-[460px] text-[12.5px] leading-relaxed text-text-3">
                  Plain English in, a read-only query, its rows and a chart out.
                  {multi && " Across the whole database the model picks the collections and joins them."}
                  {!shareSamples && " Sample data sharing is off: only collection and field names are sent."}
                </p>
              </div>
              {ready && (
                <div className="flex flex-wrap justify-center gap-2">
                  {(suggestions ?? (multi ? STARTERS_MULTI : STARTERS_SINGLE)).map((p) => (
                    <button key={p} className="starts-chip" onClick={() => void ask(p)} disabled={busy}>
                      {p}
                    </button>
                  ))}
                  <button className="starts-chip acc" onClick={() => void loadSuggestions()} disabled={suggesting || busy}>
                    {suggesting ? <Loader2 className="spin" /> : <Lightbulb />}
                    {suggestions ? "More ideas" : "Suggest questions for this data"}
                  </button>
                </div>
              )}
            </div>
          ) : (
            <div className="mx-auto flex max-w-[920px] flex-col gap-5 px-[var(--pad)] py-5">
              {turns.map((t, i) =>
                t.role === "user" ? (
                  <UserBubble
                    key={t.id}
                    text={t.text ?? ""}
                    pinned={myInsights.some((x) => sameInsight(x, { connection, prompt: t.text ?? "", database, scope }))}
                    onPin={() => {
                      addInsight({ connection, prompt: t.text ?? "", database, scope });
                      toast.success("Question saved");
                    }}
                  />
                ) : (
                  <AssistantTurn
                    key={t.id}
                    turn={t}
                    prompt={turns[i - 1]?.text ?? ""}
                    onPatch={(patch) => current && patchTurn(current.id, t.id, patch)}
                    onRetry={() => turns[i - 1]?.text && void ask(turns[i - 1].text!)}
                    onOpenShell={openShell}
                    onViewDoc={setViewDoc}
                  />
                )
              )}
              {newTopicHint && (
                <div className="notice items-center">
                  <Lightbulb />
                  <span className="flex-1">
                    That looks like a new topic. A fresh chat keeps answers focused and sends less context.
                  </span>
                  <button className="btn qt sm" onClick={() => setActive(null)}>
                    <Plus />
                    New chat
                  </button>
                </div>
              )}
              <div ref={transcriptEnd} />
            </div>
          )}
        </div>

        <div className="dock">
          <div className="studio-input">
            <textarea
              ref={inputRef}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  void ask(draft);
                }
              }}
              rows={Math.min(6, Math.max(1, draft.split("\n").length))}
              placeholder={ready ? `Ask about ${scopeLabel}...` : "Pick a database first"}
              disabled={!ready}
              autoFocus
              aria-label="Question"
            />
            <button
              className="btn pri sm"
              onClick={() => void ask(draft)}
              disabled={!ready || busy || !draft.trim()}
              aria-label="Ask"
            >
              {busy ? <Loader2 className="spin" /> : <ArrowUp />}
            </button>
          </div>
          <div className="flex items-center gap-2 font-mono text-[10.5px] text-text-3">
            <span>read-only · {model}</span>
            <span className="ml-auto">
              {current && sessionUsage.total > 0 ? `this chat: ${formatUsage(sessionUsage)} · ` : ""}⏎ ask · ⇧⏎ new line
            </span>
          </div>
        </div>
      </main>

      <Dialog open={!!viewDoc} onOpenChange={(o) => !o && setViewDoc(null)}>
        <DialogContent className="max-w-[640px]">
          <DialogHeader>
            <DialogTitle>Result row</DialogTitle>
            <DialogDescription>read-only view</DialogDescription>
          </DialogHeader>
          <DialogBody>
            <div className="rounded-[var(--r)] border border-line bg-panel px-3 py-2">
              <ValueTree value={viewDoc} />
            </div>
          </DialogBody>
        </DialogContent>
      </Dialog>
    </div>
  );
}
