import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Check, ChevronDown, ExternalLink, Loader2, RefreshCw, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { api, errMsg, type AiKeyInfo, type AiModel } from "@/lib/api";
import { openExternal } from "@/lib/links";
import { AI_MODE_META, DEFAULT_MODEL, useAi, type AiMode } from "@/stores/ai";
import { cn } from "@/lib/utils";

const KEYS_URL = "https://openrouter.ai/keys";

function price(m: AiModel): string {
  if (m.promptPrice === null || m.completionPrice === null) return "varies";
  if (m.promptPrice === 0 && m.completionPrice === 0) return "free";
  const f = (v: number) => (v < 1 ? v.toFixed(2) : v.toFixed(v < 10 ? 1 : 0));
  return `$${f(m.promptPrice)} / $${f(m.completionPrice)}`;
}

/** Searchable OpenRouter model list; any typed id is accepted too. */
function ModelPicker() {
  const { model, setModel, loadModels, models } = useAi();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);

  const fetchModels = async (force = false) => {
    setLoading(true);
    try {
      await loadModels(force);
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setLoading(false);
    }
  };

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = models ?? [];
    return (q ? list.filter((m) => m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q)) : list).slice(0, 200);
  }, [models, query]);
  const typed = query.trim();
  const typedIsNew = typed && !(models ?? []).some((m) => m.id === typed);

  const pick = (id: string) => {
    setModel(id);
    setOpen(false);
    setQuery("");
  };

  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (o && !models) void fetchModels();
      }}
    >
      <PopoverTrigger asChild>
        <button className="btn sm max-w-[260px]" aria-label="Model">
          <span className="truncate font-mono text-[11.5px]">{model}</span>
          <ChevronDown style={{ width: 12, height: 12, opacity: 0.7 }} />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[440px] p-0">
        <div className="flex items-center gap-2 border-b border-line p-2">
          <Search className="ml-1 h-3.5 w-3.5 shrink-0 text-text-3" />
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && typed) pick(shown[0]?.id === typed || !shown.length ? typed : shown[0].id);
            }}
            placeholder="Search models or type an id (vendor/model)"
            className="min-w-0 flex-1 bg-transparent font-mono text-[12px] text-text outline-none placeholder:text-text-3"
          />
          <button className="btn qt sm" onClick={() => void fetchModels(true)} disabled={loading} aria-label="Refresh model list">
            {loading ? <Loader2 className="spin" /> : <RefreshCw />}
          </button>
        </div>
        <div className="max-h-[320px] overflow-y-auto p-1">
          {typedIsNew && (
            <button className="it" onClick={() => pick(typed)}>
              <span className="n">Use "{typed}"</span>
            </button>
          )}
          {!query && (
            <button className={cn("it", model === DEFAULT_MODEL && "on")} onClick={() => pick(DEFAULT_MODEL)}>
              <span className="n">{DEFAULT_MODEL}</span>
              <span className="c">picks per request</span>
            </button>
          )}
          {loading && !models && (
            <div className="flex justify-center py-6">
              <Loader2 className="spin h-4 w-4 text-text-3" />
            </div>
          )}
          {shown
            .filter((m) => m.id !== DEFAULT_MODEL || query)
            .map((m) => (
              <button key={m.id} className={cn("it", model === m.id && "on")} onClick={() => pick(m.id)} title={m.name}>
                {model === m.id ? <Check className="text-primary" /> : <span className="w-[13px]" />}
                <span className="n">{m.id}</span>
                <span className="c">
                  {m.reasoning ? "reasons · " : ""}
                  {price(m)}
                </span>
              </button>
            ))}
          {models && shown.length === 0 && !typedIsNew && <p className="py-4 text-center text-[11.5px] text-text-3">No match</p>}
        </div>
        <div className="border-t border-line px-3 py-2 text-[10.5px] text-text-3">Prices are USD per million input / output tokens.</div>
      </PopoverContent>
    </Popover>
  );
}

function Row({ label, hint, children }: { label: string; hint?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="row">
      <div className="l">
        <b>{label}</b>
        {hint && <span>{hint}</span>}
      </div>
      <div className="rr">{children}</div>
    </div>
  );
}

/** Settings > AI: OpenRouter key (write-only), model, default mode, data sharing. */
export function AiSettings() {
  const { configured, saveKey, mode, setMode, shareSamples, setShareSamples } = useAi();
  const [key, setKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [info, setInfo] = useState<AiKeyInfo | null>(null);

  const save = async (value: string) => {
    setSaving(true);
    try {
      await saveKey(value);
      setKey("");
      setInfo(null);
      toast.success(value.trim() ? "OpenRouter key saved (encrypted)" : "OpenRouter key removed");
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setSaving(false);
    }
  };

  const test = async () => {
    setTesting(true);
    try {
      setInfo(await api.aiKeyInfo());
    } catch (e) {
      setInfo(null);
      toast.error(errMsg(e));
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="fld">
      <label>AI · OpenRouter</label>
      <div className="card">
        <Row
          label="API key"
          hint={
            configured ? (
              info ? (
                <>
                  Key works · used <b>${info.usage.toFixed(2)}</b>
                  {info.limit !== null ? ` of $${info.limit.toFixed(2)}` : ""}
                  {info.freeTier ? " · free tier" : ""}
                </>
              ) : (
                "Stored encrypted with your connection secrets. It never reaches the UI."
              )
            ) : (
              <>
                One key for every model.{" "}
                <button className="inline-flex items-center gap-1 text-primary hover:underline" onClick={() => void openExternal(KEYS_URL)}>
                  Get one at openrouter.ai <ExternalLink className="h-3 w-3" />
                </button>
              </>
            )
          }
        >
          {configured ? (
            <>
              <span className="pill ok">
                <Check /> saved
              </span>
              <Button variant="outline" size="sm" disabled={testing} onClick={() => void test()}>
                {testing && <Loader2 className="spin" />}
                Test
              </Button>
              <Button variant="outline" size="sm" disabled={saving} onClick={() => void save("")}>
                Remove
              </Button>
            </>
          ) : (
            <form
              className="flex items-center gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                if (key.trim()) void save(key);
              }}
            >
              <Input
                type="password"
                value={key}
                onChange={(e) => setKey(e.target.value)}
                placeholder="sk-or-..."
                className="h-8 w-48"
                autoComplete="off"
                spellCheck={false}
                aria-label="OpenRouter API key"
              />
              <Button size="sm" type="submit" disabled={saving || !key.trim()}>
                {saving && <Loader2 className="spin" />}
                Save
              </Button>
            </form>
          )}
        </Row>
        <Row label="Model" hint="Any model OpenRouter offers. openrouter/auto picks one per request.">
          <ModelPicker />
        </Row>
        <Row label="Default mode" hint={AI_MODE_META[mode].hint}>
          <div className="seg" role="radiogroup" aria-label="Default AI mode">
            {(Object.keys(AI_MODE_META) as AiMode[]).map((m) => (
              <button key={m} role="radio" aria-checked={mode === m} className={cn(mode === m && "on")} onClick={() => setMode(m)}>
                {AI_MODE_META[m].label}
              </button>
            ))}
          </div>
        </Row>
        <Row
          label="Share sample data with the model"
          hint="On: one sample document per collection and result rows (for summaries) are sent. Off: only collection and field names."
        >
          <Switch checked={shareSamples} onCheckedChange={setShareSamples} />
        </Row>
      </div>
    </div>
  );
}
