import { useEffect, useState } from "react";
import { Ban, Loader2, OctagonX, PackagePlus, RefreshCw, RotateCcw, ShieldOff, Unplug } from "lucide-react";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { useExplorer } from "@/stores/explorer";
import { useEngine } from "@/stores/connections";
import { api, errMsg, type Doc } from "@/lib/api";
import { formatBytes } from "@/lib/bson";
import { friendlyError, isUnauthorized } from "@/lib/errors";

interface OpsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const asNum = (v: unknown): number | null => (typeof v === "number" ? v : null);
const get = (d: Doc | undefined | null, key: string): unknown =>
  d && typeof d === "object" ? (d as Record<string, unknown>)[key] : undefined;
/** Postgres numerics / bigints may arrive as strings. */
const toNum = (v: unknown): number | null => {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
};

/** MongoDB "Unauthorized", or Postgres "permission denied" / "must be superuser". */
const isDenied = (e: unknown, pg: boolean) =>
  isUnauthorized(e) || (pg && /permission denied|must be (superuser|a member|owner)/i.test(errMsg(e)));

function formatUptime(uptime: number | null): string {
  if (uptime === null) return "-";
  return uptime > 86400
    ? `${Math.floor(uptime / 86400)}d ${Math.floor((uptime % 86400) / 3600)}h`
    : `${Math.floor(uptime / 3600)}h ${Math.floor((uptime % 3600) / 60)}m`;
}

/**
 * Inline "you can't see this" state for a tab: what the server refused, which
 * privilege / role would unlock it, and the raw error for support tickets.
 */
function PermissionNotice({
  what,
  privilege,
  roles,
  error,
  onRetry,
  pg = false,
}: {
  what: string;
  privilege: string;
  roles: string;
  error: string;
  onRetry?: () => void;
  pg?: boolean;
}) {
  return (
    <div className="flex h-full min-h-[200px] items-center justify-center px-6 py-8">
      <div className="warnbox soft max-w-[520px] flex-col gap-2">
        <div className="hstack">
          <ShieldOff />
          <b>
            Your {pg ? "PostgreSQL role" : "MongoDB user"} cannot view {what}
          </b>
        </div>
        <div className="text-text-2">
          The server refused the request: <span className="mono">{error}</span>
        </div>
        <div className="text-text-2">
          Ask your administrator for the <span className="mono">{privilege}</span> {pg ? "access" : "privilege"} - usually by granting the{" "}
          <span className="mono">{roles}</span> role - or reconnect with a user that has it. Everything else in Data Based
          keeps working; this only affects this view.
        </div>
        {onRetry && (
          <button type="button" className="btn sm self-start" onClick={onRetry}>
            <RefreshCw />
            Try again
          </button>
        )}
      </div>
    </div>
  );
}

/** Centered placeholder inside a .tw scroller (loading / empty). */
function Placeholder({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full min-h-[200px] items-center justify-center gap-2 px-6 py-12 text-center text-[12.5px] text-text-3">
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Operations tab - currentOp with kill
// ---------------------------------------------------------------------------

function OperationsTab({ active }: { active: boolean }) {
  const [ops, setOps] = useState<Doc[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [denied, setDenied] = useState<string | null>(null);
  const [killing, setKilling] = useState<unknown | null>(null);

  const load = async () => {
    setLoading(true);
    setDenied(null);
    try {
      setOps(await api.currentOps());
    } catch (e) {
      setOps([]);
      if (isUnauthorized(e)) setDenied(friendlyError(e));
      else toast.error(friendlyError(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (active) void load();
  }, [active]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="flex h-[400px] flex-col gap-2">
      <div className="flex items-center justify-between">
        <span className="mono text-[11px] text-text-3">
          {denied ? "no access" : ops === null ? "..." : `${ops.length} active operation${ops.length === 1 ? "" : "s"}`}
        </span>
        <Button variant="outline" size="xs" onClick={() => void load()}>
          {loading ? <Loader2 className="spin h-4 w-4 text-text-3" /> : <RefreshCw />}
          Refresh
        </Button>
      </div>
      <div className="tw rounded-[var(--r-sm)] border border-line bg-panel">
        {denied ? (
          <PermissionNotice
            what="running operations"
            privilege="inprog (and killop to kill)"
            roles="clusterMonitor / hostManager"
            error={denied}
            onRetry={() => void load()}
          />
        ) : ops === null || ops.length === 0 ? (
          <Placeholder>
            {ops === null && <Loader2 className="spin h-4 w-4 text-text-3" />}
            {ops === null ? "Loading..." : "No active operations right now."}
          </Placeholder>
        ) : (
          <table className="tbl">
            <thead>
              <tr>
                <th>op</th>
                <th>ns</th>
                <th>
                  running<span className="ty">s</span>
                </th>
                <th>command</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {ops.map((op, i) => {
                const opid = get(op, "opid");
                const secs = asNum(get(op, "secs_running"));
                return (
                  <tr key={i}>
                    <td className="text-text">{String(get(op, "op") ?? "?")}</td>
                    <td className="max-w-[200px] truncate">{String(get(op, "ns") ?? "")}</td>
                    <td>
                      {secs !== null ? (
                        <span className={secs >= 5 ? "pill warn" : "pill"}>{secs}s</span>
                      ) : (
                        <span className="text-text-3">-</span>
                      )}
                    </td>
                    <td className="max-w-[300px] truncate text-text-3">
                      {JSON.stringify(get(op, "command") ?? {}).slice(0, 160)}
                    </td>
                    <td className="text-right">
                      {opid !== undefined && (
                        <button type="button" className="btn dgr sm" onClick={() => setKilling(opid)}>
                          <OctagonX />
                          Kill
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      <ConfirmDialog
        open={killing !== null}
        onOpenChange={(o) => !o && setKilling(null)}
        title="Kill this operation?"
        description="The operation is interrupted server-side. The client that issued it will see an error."
        confirmLabel="Kill operation"
        destructive
        onConfirm={async () => {
          try {
            await api.killOp(killing);
            toast.success("Kill signal sent");
            setKilling(null);
            await load();
          } catch (e) {
            toast.error(
              isUnauthorized(e)
                ? "Your MongoDB user cannot kill operations - it needs the killop privilege (hostManager role)."
                : friendlyError(e)
            );
          }
        }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Operations tab (Postgres) - pg_stat_activity with cancel / terminate
// ---------------------------------------------------------------------------

type PgSignal = { pid: number; terminate: boolean };

function PgOperationsTab({ active }: { active: boolean }) {
  const [ops, setOps] = useState<Doc[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [denied, setDenied] = useState<string | null>(null);
  const [terminating, setTerminating] = useState<number | null>(null);

  const load = async () => {
    setLoading(true);
    setDenied(null);
    try {
      setOps(await api.currentOps());
    } catch (e) {
      setOps([]);
      if (isDenied(e, true)) setDenied(friendlyError(e));
      else toast.error(friendlyError(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (active) void load();
  }, [active]); // eslint-disable-line react-hooks/exhaustive-deps

  const signal = async ({ pid, terminate }: PgSignal) => {
    try {
      await api.killOp(terminate ? { pid, terminate: true } : pid);
      toast.success(terminate ? `Connection ${pid} terminated` : `Cancel sent to backend ${pid}`);
      setTerminating(null);
      await load();
    } catch (e) {
      toast.error(
        isDenied(e, true)
          ? `Your PostgreSQL role cannot signal backend ${pid} - it must be a superuser, the same role, or a member of pg_signal_backend.`
          : friendlyError(e)
      );
    }
  };

  return (
    <div className="flex h-[400px] flex-col gap-2">
      <div className="flex items-center justify-between">
        <span className="mono text-[11px] text-text-3">
          {denied ? "no access" : ops === null ? "..." : `${ops.length} active backend${ops.length === 1 ? "" : "s"}`}
        </span>
        <Button variant="outline" size="xs" onClick={() => void load()}>
          {loading ? <Loader2 className="spin h-4 w-4 text-text-3" /> : <RefreshCw />}
          Refresh
        </Button>
      </div>
      <div className="tw rounded-[var(--r-sm)] border border-line bg-panel">
        {denied ? (
          <PermissionNotice
            pg
            what="other sessions' activity"
            privilege="pg_read_all_stats (and pg_signal_backend to cancel)"
            roles="pg_monitor"
            error={denied}
            onRetry={() => void load()}
          />
        ) : ops === null || ops.length === 0 ? (
          <Placeholder>
            {ops === null && <Loader2 className="spin h-4 w-4 text-text-3" />}
            {ops === null ? "Loading..." : "No active queries right now - every connection is idle."}
          </Placeholder>
        ) : (
          <table className="tbl">
            <thead>
              <tr>
                <th>pid</th>
                <th>state</th>
                <th>who</th>
                <th>
                  running<span className="ty">s</span>
                </th>
                <th>query</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {ops.map((op, i) => {
                const pid = toNum(get(op, "pid"));
                const secs = toNum(get(op, "secs_running"));
                const wait = get(op, "waitEvent");
                const who = [get(op, "user"), get(op, "appName"), get(op, "client")]
                  .filter((v) => typeof v === "string" && v !== "")
                  .join(" · ");
                const query = String(get(op, "query") ?? "");
                return (
                  <tr key={pid ?? i}>
                    <td className="text-text tabular-nums">{pid ?? "?"}</td>
                    <td>
                      <span className="inline-flex items-center gap-1">
                        {String(get(op, "state") ?? "?")}
                        {get(op, "waitingForLock") === true && (
                          <span className="pill warn" title={typeof wait === "string" ? wait : undefined}>
                            lock
                          </span>
                        )}
                      </span>
                    </td>
                    <td className="max-w-[160px] truncate" title={who}>
                      {who || <span className="text-text-3">-</span>}
                    </td>
                    <td>
                      {secs !== null ? (
                        <span className={secs >= 5 ? "pill warn" : "pill"}>
                          {secs < 10 ? secs.toFixed(1) : Math.round(secs)}s
                        </span>
                      ) : (
                        <span className="text-text-3">-</span>
                      )}
                    </td>
                    <td className="max-w-[260px] truncate text-text-3" title={query}>
                      {query.replace(/\s+/g, " ").slice(0, 200)}
                    </td>
                    <td className="text-right">
                      {pid !== null && (
                        <span className="inline-flex gap-1">
                          <button
                            type="button"
                            className="btn sm"
                            title="Cancel the running query (pg_cancel_backend) - the connection stays open"
                            onClick={() => void signal({ pid, terminate: false })}
                          >
                            <Ban />
                            Cancel
                          </button>
                          <button
                            type="button"
                            className="btn dgr sm"
                            title="Close this connection (pg_terminate_backend)"
                            onClick={() => setTerminating(pid)}
                          >
                            <Unplug />
                            Terminate
                          </button>
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      <ConfirmDialog
        open={terminating !== null}
        onOpenChange={(o) => !o && setTerminating(null)}
        title={`Terminate backend ${terminating ?? ""}?`}
        description="The connection is closed server-side and any open transaction is rolled back. The client will see a dropped connection."
        confirmLabel="Terminate connection"
        destructive
        onConfirm={async () => {
          if (terminating !== null) await signal({ pid: terminating, terminate: true });
        }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Profiler tab
// ---------------------------------------------------------------------------

function ProfilerTab({ active }: { active: boolean }) {
  const databases = useExplorer((s) => s.databases);
  const [db, setDb] = useState("");
  const [level, setLevel] = useState<number | null>(null);
  const [slowMs, setSlowMs] = useState<number | null>(null);
  const [entries, setEntries] = useState<Doc[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [denied, setDenied] = useState<string | null>(null);

  useEffect(() => {
    if (active && !db && databases.length > 0) setDb(databases[0].name);
  }, [active, databases, db]);

  const load = async (database: string) => {
    if (!database) return;
    setLoading(true);
    setDenied(null);
    try {
      const [status, rows] = await Promise.all([
        api.profilerStatus(database),
        api.profilerEntries(database, 50).catch(() => []),
      ]);
      setLevel(asNum(get(status, "was")));
      setSlowMs(asNum(get(status, "slowms")));
      setEntries(rows);
    } catch (e) {
      setEntries([]);
      setLevel(null);
      if (isUnauthorized(e)) setDenied(friendlyError(e));
      else toast.error(friendlyError(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (active && db) void load(db);
  }, [active, db]); // eslint-disable-line react-hooks/exhaustive-deps

  const changeLevel = async (next: number) => {
    try {
      await api.setProfiler(db, next, slowMs ?? undefined);
      toast.success(
        next === 0 ? "Profiler off" : next === 1 ? `Profiling ops slower than ${slowMs ?? 100}ms` : "Profiling all operations"
      );
      await load(db);
    } catch (e) {
      toast.error(
        isUnauthorized(e)
          ? `Your MongoDB user cannot change the profiler on ${db} - it needs the enableProfiler privilege (dbAdmin role).`
          : friendlyError(e)
      );
    }
  };

  return (
    <div className="flex h-[400px] flex-col gap-3">
      <div className="flex items-end gap-3">
        <div className="fld w-[200px]">
          <label>Database</label>
          <Select value={db} onValueChange={setDb}>
            <SelectTrigger className="h-[34px] font-mono text-xs">
              <SelectValue placeholder="Database" />
            </SelectTrigger>
            <SelectContent>
              {databases.map((d) => (
                <SelectItem key={d.name} value={d.name} className="font-mono text-xs">
                  {d.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="fld">
          <label>Profiling level</label>
          <div className="seg">
            {[
              { v: 0, label: "Off" },
              { v: 1, label: `Slow ops${slowMs != null ? ` (>${slowMs}ms)` : ""}` },
              { v: 2, label: "All ops" },
            ].map((o) => (
              <button
                key={o.v}
                type="button"
                className={level === o.v ? "on" : undefined}
                onClick={() => void changeLevel(o.v)}
              >
                {o.label}
              </button>
            ))}
          </div>
        </div>
        <div className="flex-1" />
        <Button variant="outline" size="sm" onClick={() => void load(db)}>
          {loading ? <Loader2 className="spin h-4 w-4 text-text-3" /> : <RefreshCw />}
          Refresh
        </Button>
      </div>

      <div className="tw rounded-[var(--r-sm)] border border-line bg-panel">
        {denied ? (
          <PermissionNotice
            what={`the profiler on ${db}`}
            privilege="enableProfiler and read on system.profile"
            roles={`dbAdmin on ${db}`}
            error={denied}
            onRetry={() => void load(db)}
          />
        ) : !entries || entries.length === 0 ? (
          <Placeholder>
            {entries === null && <Loader2 className="spin h-4 w-4 text-text-3" />}
            {entries === null
              ? "Loading..."
              : "No profiler entries. Turn the profiler on (Slow ops) and run some queries - they'll show up here."}
          </Placeholder>
        ) : (
          <table className="tbl">
            <thead>
              <tr>
                <th>op</th>
                <th>ns</th>
                <th>
                  time<span className="ty">ms</span>
                </th>
                <th>plan</th>
                <th>command</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e, i) => {
                const millis = asNum(get(e, "millis"));
                const collscan = String(get(e, "planSummary") ?? "").includes("COLLSCAN");
                return (
                  <tr key={i}>
                    <td className="text-text">{String(get(e, "op") ?? "?")}</td>
                    <td className="max-w-[200px] truncate">{String(get(e, "ns") ?? "")}</td>
                    <td>
                      {millis !== null ? (
                        <span className={millis >= 100 ? "pill warn" : "pill"}>{millis}ms</span>
                      ) : (
                        <span className="text-text-3">-</span>
                      )}
                    </td>
                    <td>{collscan ? <span className="pill dgr">COLLSCAN</span> : <span className="text-text-3">-</span>}</td>
                    <td className="max-w-[300px] truncate text-text-3">
                      {JSON.stringify(get(e, "command") ?? get(e, "query") ?? {}).slice(0, 160)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Top statements tab (Postgres) - pg_stat_statements plays the profiler
// ---------------------------------------------------------------------------

/** PG13+ names first, PG12's `total_time` / `mean_time` / `max_time` second. */
const ms = (row: Doc, key: "total" | "mean" | "max") =>
  toNum(get(row, `${key}_exec_time`)) ?? toNum(get(row, `${key}_time`));

const fmtMs = (v: number | null) =>
  v === null ? "-" : v >= 1000 ? `${(v / 1000).toFixed(v >= 10000 ? 0 : 1)}s` : `${v < 10 ? v.toFixed(2) : Math.round(v)}ms`;

function PgStatementsTab({ active }: { active: boolean }) {
  const databases = useExplorer((s) => s.databases);
  const [status, setStatus] = useState<Doc | null>(null);
  const [entries, setEntries] = useState<Doc[] | null>(null);
  const [entriesError, setEntriesError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [denied, setDenied] = useState<string | null>(null);
  const [resetting, setResetting] = useState(false);
  // pg_stat_statements is per-database; the schema argument is ignored.
  const schema = databases[0]?.name ?? "public";

  const load = async () => {
    setLoading(true);
    setDenied(null);
    setEntriesError(null);
    try {
      const st = await api.profilerStatus(schema);
      setStatus(st);
      if (get(st, "installed") === true && get(st, "preloaded") === true) {
        try {
          setEntries(await api.profilerEntries(schema, 50));
        } catch (e) {
          setEntries([]);
          if (isDenied(e, true)) setDenied(friendlyError(e));
          else setEntriesError(friendlyError(e));
        }
      } else {
        setEntries([]);
      }
    } catch (e) {
      setEntries([]);
      if (isDenied(e, true)) setDenied(friendlyError(e));
      else toast.error(friendlyError(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (active) void load();
  }, [active]); // eslint-disable-line react-hooks/exhaustive-deps

  const apply = async (level: 0 | 1) => {
    try {
      await api.setProfiler(schema, level);
      toast.success(level === 1 ? "pg_stat_statements installed" : "Statement statistics reset");
      setResetting(false);
      await load();
    } catch (e) {
      toast.error(
        isDenied(e, true)
          ? level === 1
            ? "Your PostgreSQL role cannot create extensions in this database - ask a superuser or the database owner."
            : "Your PostgreSQL role cannot reset pg_stat_statements - it needs EXECUTE on pg_stat_statements_reset()."
          : friendlyError(e)
      );
    }
  };

  const installed = get(status, "installed") === true;
  const available = get(status, "available") === true;
  const preloaded = get(status, "preloaded") === true;
  const ready = installed && preloaded;

  const setup = !status ? null : !available && !installed ? (
    <>
      <b>pg_stat_statements is not available on this server</b>
      <div className="text-text-2">
        The extension ships with PostgreSQL's contrib package. Install it on the server (managed providers usually
        have it enabled already), then add it to <span className="mono">shared_preload_libraries</span> and restart.
      </div>
    </>
  ) : !preloaded ? (
    <>
      <b>pg_stat_statements is not loaded</b>
      <div className="text-text-2">
        Statement statistics are collected only when the server starts with{" "}
        <span className="mono">shared_preload_libraries = 'pg_stat_statements'</span> in postgresql.conf (or your
        provider's parameter group). That needs a server restart.
        {!installed && " After that, install the extension in this database."}
      </div>
      {!installed && (
        <button type="button" className="btn sm self-start" onClick={() => void apply(1)}>
          <PackagePlus />
          Install extension anyway
        </button>
      )}
    </>
  ) : !installed ? (
    <>
      <b>pg_stat_statements is loaded but not installed in this database</b>
      <div className="text-text-2">
        Installing runs <span className="mono">CREATE EXTENSION IF NOT EXISTS pg_stat_statements</span> - it needs a
        superuser or the database owner.
      </div>
      <button type="button" className="btn sm self-start" onClick={() => void apply(1)}>
        <PackagePlus />
        Install extension
      </button>
    </>
  ) : null;

  return (
    <div className="flex h-[400px] flex-col gap-3">
      <div className="flex items-center gap-3">
        <p className="hint flex-1">
          Top statements by total execution time from <span className="mono">pg_stat_statements</span>, cumulative
          since the last reset.
        </p>
        {ready && (
          <Button variant="outline" size="sm" onClick={() => setResetting(true)}>
            <RotateCcw />
            Reset
          </Button>
        )}
        <Button variant="outline" size="sm" onClick={() => void load()}>
          {loading ? <Loader2 className="spin h-4 w-4 text-text-3" /> : <RefreshCw />}
          Refresh
        </Button>
      </div>

      <div className="tw rounded-[var(--r-sm)] border border-line bg-panel">
        {denied ? (
          <PermissionNotice
            pg
            what="statement statistics"
            privilege="pg_read_all_stats"
            roles="pg_monitor"
            error={denied}
            onRetry={() => void load()}
          />
        ) : setup ? (
          <div className="flex h-full min-h-[200px] items-center justify-center px-6 py-8">
            <div className="warnbox soft max-w-[560px] flex-col gap-2">{setup}</div>
          </div>
        ) : entriesError ? (
          <Placeholder>
            <span className="mono">{entriesError}</span>
          </Placeholder>
        ) : !entries || entries.length === 0 ? (
          <Placeholder>
            {entries === null && <Loader2 className="spin h-4 w-4 text-text-3" />}
            {entries === null ? "Loading..." : "No statements recorded yet. Run some queries and refresh."}
          </Placeholder>
        ) : (
          <table className="tbl">
            <thead>
              <tr>
                <th>query</th>
                <th className="text-right">calls</th>
                <th className="text-right">total</th>
                <th className="text-right">mean</th>
                <th className="text-right">max</th>
                <th className="text-right">rows</th>
                <th className="text-right">cache hit</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e, i) => {
                const query = String(get(e, "query") ?? "");
                const mean = ms(e, "mean");
                const hit = toNum(get(e, "shared_blks_hit")) ?? 0;
                const read = toNum(get(e, "shared_blks_read")) ?? 0;
                const ratio = hit + read > 0 ? hit / (hit + read) : null;
                return (
                  <tr key={i}>
                    <td className="max-w-[340px] truncate text-text" title={query}>
                      {query.replace(/\s+/g, " ").slice(0, 240)}
                    </td>
                    <td className="text-right tabular-nums">{toNum(get(e, "calls"))?.toLocaleString() ?? "-"}</td>
                    <td className="text-right tabular-nums">{fmtMs(ms(e, "total"))}</td>
                    <td className="text-right">
                      <span className={mean !== null && mean >= 100 ? "pill warn" : "pill"}>{fmtMs(mean)}</span>
                    </td>
                    <td className="text-right tabular-nums">{fmtMs(ms(e, "max"))}</td>
                    <td className="text-right tabular-nums">{toNum(get(e, "rows"))?.toLocaleString() ?? "-"}</td>
                    <td className={ratio !== null && ratio < 0.9 ? "text-right tabular-nums text-warn" : "text-right tabular-nums"}>
                      {ratio === null ? "-" : `${(ratio * 100).toFixed(1)}%`}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      <ConfirmDialog
        open={resetting}
        onOpenChange={setResetting}
        title="Reset statement statistics?"
        description="Runs pg_stat_statements_reset(). Every counter in pg_stat_statements starts again from zero."
        confirmLabel="Reset statistics"
        destructive
        onConfirm={() => apply(0)}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Live stats tab - 2s polling while visible
// ---------------------------------------------------------------------------

function LiveTab({ active }: { active: boolean }) {
  const pg = useEngine() === "postgres";
  const [status, setStatus] = useState<Doc | null>(null);
  const [prev, setPrev] = useState<Doc | null>(null);
  const [denied, setDenied] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    if (!active) return;
    let stale = false;
    let timer: ReturnType<typeof setInterval> | null = null;
    const tick = async () => {
      try {
        const s = await api.serverStatusLight();
        if (stale) return;
        setDenied(null);
        setStatus((cur) => {
          setPrev(cur);
          return s;
        });
      } catch (e) {
        if (stale) return;
        if (isDenied(e, pg)) {
          // No point polling every 2s against a permission wall.
          setDenied(friendlyError(e));
          if (timer) clearInterval(timer);
        }
        // otherwise: server hiccup, keep the last numbers
      }
    };
    void tick();
    timer = setInterval(() => void tick(), 2000);
    return () => {
      stale = true;
      if (timer) clearInterval(timer);
    };
  }, [active, retry, pg]);

  const opc = (d: Doc | null) => (get(d, "opcounters") ?? {}) as Doc;
  // Per-second rates from the 2s polling delta.
  const perSec = (now: number | null, before: number | null): string => {
    if (now === null || before === null) return "-";
    return `${Math.max(0, Math.round((now - before) / 2)).toLocaleString()}/s`;
  };
  const rate = (key: string): string => perSec(asNum(get(opc(status), key)), asNum(get(opc(prev), key)));

  const conn = (get(status, "connections") ?? {}) as Doc;
  const mem = (get(status, "mem") ?? {}) as Doc;
  const uptime = asNum(get(status, "uptime"));

  // Postgres: the opcounters are pg_stat_database tuple / transaction totals.
  const pgs = (get(status, "pg") ?? {}) as Doc;
  const pgRate = (key: string) => perSec(toNum(get(pgs, key)), toNum(get(get(prev, "pg") as Doc, key)));
  const blksHit = toNum(get(pgs, "blksHit"));
  const blksRead = toNum(get(pgs, "blksRead"));
  const hitRatio =
    blksHit !== null && blksRead !== null && blksHit + blksRead > 0 ? blksHit / (blksHit + blksRead) : null;
  const maxConns = toNum(get(pgs, "maxConnections"));
  const dbSize = toNum(get(pgs, "databaseSize"));
  const pgCards: [string, string][] = [
    ["Rows read", rate("query")],
    ["Rows inserted", rate("insert")],
    ["Rows updated", rate("update")],
    ["Rows deleted", rate("delete")],
    ["Transactions", rate("command")],
    ["Rollbacks", pgRate("xactRollback")],
    [
      "Connections",
      asNum(get(conn, "current")) !== null
        ? `${asNum(get(conn, "current"))!.toLocaleString()}${maxConns !== null ? ` / ${maxConns.toLocaleString()}` : ""}`
        : "-",
    ],
    ["Active conns", asNum(get(conn, "active"))?.toLocaleString() ?? "-"],
    ["Cache hit ratio", hitRatio !== null ? `${(hitRatio * 100).toFixed(2)}%` : "-"],
    ["Database size", dbSize !== null ? formatBytes(dbSize) : "-"],
    ["Uptime", formatUptime(uptime)],
    ["Server", String(get(status, "version") ?? "-")],
  ];

  const cards: [string, string][] = pg ? pgCards : [
    ["Queries", rate("query")],
    ["Inserts", rate("insert")],
    ["Updates", rate("update")],
    ["Deletes", rate("delete")],
    ["Commands", rate("command")],
    ["Getmores", rate("getmore")],
    ["Connections", asNum(get(conn, "current"))?.toLocaleString() ?? "-"],
    ["Available conns", asNum(get(conn, "available"))?.toLocaleString() ?? "-"],
    ["Resident mem", asNum(get(mem, "resident")) !== null ? `${asNum(get(mem, "resident"))} MB` : "-"],
    ["Virtual mem", asNum(get(mem, "virtual")) !== null ? `${asNum(get(mem, "virtual"))} MB` : "-"],
    ["Uptime", formatUptime(uptime)],
    ["Server", String(get(status, "version") ?? "-")],
  ];

  return (
    <div className="flex h-[400px] flex-col gap-3">
      <p className="hint">
        {pg
          ? "Live metrics for this database from pg_stat_database - refreshed every 2 seconds while this tab is open. Rates are per-second deltas; the cache hit ratio is cumulative since the last stats reset."
          : "Live server metrics - refreshed every 2 seconds while this tab is open. Op rates are per-second deltas."}
      </p>
      {denied ? (
        <div className="tw rounded-[var(--r-sm)] border border-line bg-panel">
          <PermissionNotice
            pg={pg}
            what="live server metrics"
            privilege={pg ? "pg_read_all_stats" : "serverStatus"}
            roles={pg ? "pg_monitor" : "clusterMonitor"}
            error={denied}
            onRetry={() => setRetry((n) => n + 1)}
          />
        </div>
      ) : (
      <div className="statgrid">
        {cards.map(([label, value]) => (
          <div key={label}>
            <div className="l">{label}</div>
            <div className="v mono truncate tabular-nums">{value}</div>
          </div>
        ))}
      </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

export function OpsDialog({ open, onOpenChange }: OpsDialogProps) {
  const pg = useEngine() === "postgres";
  const [tab, setTab] = useState("operations");

  const tabs: [string, string][] = [
    ["operations", pg ? "Activity" : "Operations"],
    ["profiler", pg ? "Top statements" : "Profiler"],
    ["live", "Live stats"],
  ];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[820px]">
        <DialogHeader>
          <DialogTitle>Server operations</DialogTitle>
          <DialogDescription>
            {pg
              ? "active queries · pg_stat_statements · real-time database metrics"
              : "live operations · query profiler · real-time server metrics"}
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          <div className="seg self-start">
            {tabs.map(([v, label]) => (
              <button
                key={v}
                type="button"
                className={tab === v ? "on" : undefined}
                onClick={() => setTab(v)}
              >
                {label}
              </button>
            ))}
          </div>
          {tab === "operations" &&
            (pg ? (
              <PgOperationsTab active={open && tab === "operations"} />
            ) : (
              <OperationsTab active={open && tab === "operations"} />
            ))}
          {tab === "profiler" &&
            (pg ? (
              <PgStatementsTab active={open && tab === "profiler"} />
            ) : (
              <ProfilerTab active={open && tab === "profiler"} />
            ))}
          {tab === "live" && <LiveTab active={open && tab === "live"} />}
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
