import { useEffect, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { Copy, Loader2, RefreshCw, ShieldAlert, ShieldCheck } from "lucide-react";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useConnections, useEngine } from "@/stores/connections";
import { friendlyError, isUnauthorized } from "@/lib/errors";
import { api, errMsg, type ServerInfoRaw } from "@/lib/api";
import { formatBytes, formatCount, toPlainJson, toPlainValue } from "@/lib/bson";

interface ServerInfoDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

// --- safe accessors over the plain-JS server-info blob --------------------
const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string | null =>
  typeof v === "string" && v.trim() !== "" ? v : typeof v === "number" && Number.isFinite(v) ? String(v) : null;
const num = (v: unknown): number | null => {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
};
const count = (v: unknown): string | null => {
  const n = num(v);
  return n === null ? null : formatCount(n);
};
const bytes = (v: unknown): string | null => {
  const n = num(v);
  return n === null ? null : formatBytes(n);
};

function formatUptime(seconds: number | null): string | null {
  if (seconds === null || seconds < 0) return null;
  const s = Math.floor(seconds);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const parts: string[] = [];
  if (d) parts.push(`${d}d`);
  if (h) parts.push(`${h}h`);
  parts.push(`${m}m`);
  return parts.join(" ");
}

type Row = [string, ReactNode];

const present = (rows: Row[]) => rows.filter(([, v]) => v !== null && v !== undefined && v !== "");

/** Uppercase mono label + a .card of key/value rows. */
function Section({ title, rows = [], children }: { title: string; rows?: Row[]; children?: ReactNode }) {
  const visible = present(rows);
  if (visible.length === 0 && !children) return null;
  return (
    <div className="fld">
      <label>{title}</label>
      <div className="card">
        {visible.map(([label, value]) => (
          <div key={label} className="row">
            <div className="l">
              <b>{label}</b>
            </div>
            <div className="rr mono min-w-0 max-w-[65%] break-all text-right text-[12px] text-text">{value}</div>
          </div>
        ))}
        {children}
      </div>
    </div>
  );
}

/** Uppercase mono label + .statgrid tiles. */
function StatSection({ title, rows, five }: { title: string; rows: Row[]; five?: boolean }) {
  const visible = present(rows);
  if (visible.length === 0) return null;
  return (
    <div className="fld">
      <label>{title}</label>
      <div className={five ? "statgrid five" : "statgrid"}>
        {visible.map(([label, value]) => (
          <div key={label}>
            <div className="l">{label}</div>
            <div className="v mono truncate tabular-nums">{value}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

export function ServerInfoDialog({ open, onOpenChange }: ServerInfoDialogProps) {
  const active = useConnections((s) => s.active);
  const pg = useEngine() === "postgres";
  const [raw, setRaw] = useState<ServerInfoRaw | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = () => {
    setLoading(true);
    setError(null);
    api
      .serverInfo()
      .then(setRaw)
      .catch((e) => setError(errMsg(e)))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    if (open) load();
    else {
      setRaw(null);
      setError(null);
    }
  }, [open]);

  const copyJson = async () => {
    if (!raw) return;
    await navigator.clipboard.writeText(toPlainJson(raw));
    toast.success("Server details copied");
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[720px]">
        <DialogHeader>
          <DialogTitle>
            {pg ? "PostgreSQL" : "MongoDB"} {active?.serverVersion ?? ""}
          </DialogTitle>
          <DialogDescription className="truncate">
            {pg ? active?.database : active?.topology}
            {active?.hostSummary ? ` · ${active.hostSummary}` : ""}
          </DialogDescription>
        </DialogHeader>

        <DialogBody>
          {loading && (
            <div className="flex items-center justify-center gap-2 py-12 text-[12.5px] text-text-3">
              <Loader2 className="spin h-4 w-4 text-text-3" />
              Reading server status...
            </div>
          )}

          {error && !loading && (
            <div className="flex flex-col items-center gap-3 py-8 text-center">
              {pg && /permission denied/i.test(error) ? (
                <div className="warnbox soft max-w-md flex-col gap-2 text-left">
                  <b>Your PostgreSQL role cannot read server details</b>
                  <div className="text-text-2">
                    The server refused the request: <span className="mono">{friendlyError(error)}</span>
                  </div>
                  <div className="text-text-2">
                    Granting <span className="mono">pg_monitor</span> (or <span className="mono">pg_read_all_settings</span>{" "}
                    and <span className="mono">pg_read_all_stats</span>) unlocks this view.
                  </div>
                </div>
              ) : !pg && isUnauthorized(error) ? (
                <div className="warnbox soft max-w-md flex-col gap-2 text-left">
                  <b>Your MongoDB user cannot read server details</b>
                  <div className="text-text-2">
                    The server refused the request: <span className="mono">{friendlyError(error)}</span>
                  </div>
                  <div className="text-text-2">
                    buildInfo, hello, serverStatus and hostInfo need the <span className="mono">clusterMonitor</span> role
                    (or the <span className="mono">serverStatus</span> / <span className="mono">hostInfo</span> privileges).
                    Ask your administrator, or reconnect with a user that has them.
                  </div>
                </div>
              ) : (
                <div className="notice dgr mono max-w-md">{friendlyError(error)}</div>
              )}
              <Button variant="outline" size="sm" onClick={load}>
                <RefreshCw />
                Retry
              </Button>
            </div>
          )}

          {!loading && !error && raw &&
            (pg ? (
              <PgBody raw={raw} />
            ) : (
              <Body raw={raw} fallbackVersion={active?.serverVersion} fallbackTopology={active?.topology} />
            ))}
        </DialogBody>

        <DialogFooter className="justify-between">
          <Button variant="ghost" size="sm" disabled={!raw} onClick={() => void copyJson()}>
            <Copy />
            Copy as JSON
          </Button>
          <Button variant="outline" size="sm" disabled={loading} onClick={load}>
            {loading ? <Loader2 className="spin h-4 w-4 text-text-3" /> : <RefreshCw />}
            Refresh
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Body({
  raw,
  fallbackVersion,
  fallbackTopology,
}: {
  raw: ServerInfoRaw;
  fallbackVersion?: string;
  fallbackTopology?: string;
}) {
  const plain = obj(toPlainValue(raw));
  const bi = obj(plain.buildInfo);
  const hello = obj(plain.hello);
  const ss = obj(plain.serverStatus);
  const hi = obj(plain.hostInfo);
  const cs = obj(plain.connectionStatus);

  // build
  const git = str(bi.gitVersion);
  const modules = arr(bi.modules)
    .map((m) => str(m))
    .filter(Boolean) as string[];
  const buildRows: Row[] = [
    ["Version", str(bi.version) ?? fallbackVersion ?? null],
    ["Git revision", git ? `${git.slice(0, 12)}...` : null],
    ["Storage engine", str(obj(ss.storageEngine).name)],
    ["JS engine", str(bi.javascriptEngine)],
    ["Allocator", str(bi.allocator)],
    ["Architecture", num(bi.bits) ? `${num(bi.bits)}-bit` : null],
    ["Max document size", bytes(bi.maxBsonObjectSize)],
    ["OpenSSL", str(obj(bi.openssl).running)],
    ["Modules", modules.length ? modules.join(", ") : null],
  ];

  // deployment
  const hosts = arr(hello.hosts)
    .map((h) => str(h))
    .filter(Boolean) as string[];
  const primary = str(hello.primary);
  const me = str(hello.me);
  const minW = num(hello.minWireVersion);
  const maxW = num(hello.maxWireVersion);
  const deployRows: Row[] = [
    ["Topology", fallbackTopology ?? null],
    ["Replica set", str(hello.setName)],
    ["Current node", me],
    ["Wire protocol", minW !== null && maxW !== null ? `v${minW}-v${maxW}` : null],
    ["Read only", hello.readOnly === true ? "yes" : null],
  ];

  // host system
  const sys = obj(hi.system);
  const os = obj(hi.os);
  const osName = str(os.name) ?? str(os.type);
  const osVersion = str(os.version);
  const cores = num(sys.numCores);
  const cpuArch = str(sys.cpuArch);
  const memMb = num(sys.memSizeMB);
  const hostRows: Row[] = [
    ["Hostname", str(sys.hostname)],
    ["OS", osName ? `${osName}${osVersion ? ` ${osVersion}` : ""}` : null],
    ["CPU", cores !== null ? `${cores} cores${cpuArch ? ` · ${cpuArch}` : ""}` : null],
    ["Memory", memMb !== null ? formatBytes(memMb * 1024 * 1024) : null],
  ];

  // runtime
  const runtimeRows: Row[] = [
    ["Host", str(ss.host) ?? me],
    ["Process", str(ss.process)],
    ["PID", str(ss.pid)],
    ["Uptime", formatUptime(num(ss.uptime))],
    ["Local time", str(hello.localTime)],
  ];

  // connections
  const conn = obj(ss.connections);
  const connRows: Row[] = [
    ["Current", count(conn.current)],
    ["Active", count(conn.active)],
    ["Available", count(conn.available)],
    ["Total created", count(conn.totalCreated)],
  ];

  // operations
  const ops = obj(ss.opcounters);
  const opRows: Row[] = [
    ["Insert", count(ops.insert)],
    ["Query", count(ops.query)],
    ["Update", count(ops.update)],
    ["Delete", count(ops.delete)],
    ["Getmore", count(ops.getmore)],
    ["Command", count(ops.command)],
  ];

  // network
  const net = obj(ss.network);
  const netRows: Row[] = [
    ["Bytes in", bytes(net.bytesIn)],
    ["Bytes out", bytes(net.bytesOut)],
    ["Requests", count(net.numRequests)],
  ];

  // authentication
  const authInfo = obj(cs.authInfo);
  const users = arr(authInfo.authenticatedUsers)
    .map((u) => {
      const o = obj(u);
      const user = str(o.user);
      return user ? `${user}${str(o.db) ? `@${str(o.db)}` : ""}` : null;
    })
    .filter(Boolean) as string[];
  const roles = arr(authInfo.authenticatedUserRoles)
    .map((r) => {
      const o = obj(r);
      const role = str(o.role);
      return role ? `${role}${str(o.db) ? `@${str(o.db)}` : ""}` : null;
    })
    .filter(Boolean) as string[];

  return (
    <>
      <StatSection title="Connections" rows={connRows} />
      <StatSection title="Operations (since start)" rows={opRows} />

      <Section title="Build" rows={buildRows} />

      <Section title="Deployment" rows={deployRows}>
        {hosts.length > 0 && (
          <div className="flex flex-col gap-2 px-[14px] py-3">
            <span className="lbl">{hosts.length === 1 ? "Host" : `${hosts.length} hosts`}</span>
            {hosts.map((h) => (
              <div key={h} className="flex items-center justify-between gap-2 font-mono text-[12px]">
                <span className="break-all text-text">{h}</span>
                {h === primary ? (
                  <span className="pill acc">primary</span>
                ) : h === me ? (
                  <span className="pill">connected</span>
                ) : null}
              </div>
            ))}
          </div>
        )}
      </Section>

      <Section title="Host system" rows={hostRows} />
      <Section title="Runtime" rows={runtimeRows} />
      <StatSection title="Network" rows={netRows} />

      <Section
        title="Authentication"
        rows={[
          ["User", users.length ? users.join(", ") : "unauthenticated"],
          ["Roles", roles.length ? roles.join(", ") : null],
        ]}
      />
    </>
  );
}

// --- PostgreSQL ----------------------------------------------------------

function when(v: unknown): string | null {
  const s = str(v);
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? s : d.toLocaleString();
}

/** A pg_settings value in its unit: memory settings as bytes, the rest verbatim. */
function settingText(setting: unknown, unit: unknown): string | null {
  const v = str(setting);
  if (v === null) return null;
  const n = num(setting);
  const u = str(unit);
  const scale: Record<string, number> = { B: 1, kB: 1024, "8kB": 8192, MB: 1024 ** 2, GB: 1024 ** 3 };
  if (n !== null && u && u in scale) return n < 0 ? String(n) : formatBytes(n * scale[u]);
  return u ? `${v} ${u}` : v;
}

/**
 * Server details for a Postgres workspace. Every section comes from its own
 * catalog query and is null when the role can't read it (managed providers
 * often hide pg_settings / pg_stat_replication), so each renders on its own.
 */
function PgBody({ raw }: { raw: ServerInfoRaw }) {
  const plain = obj(toPlainValue(raw));
  const server = obj(plain.server);
  const session = obj(plain.session);
  const db = obj(plain.database);
  const settings = arr(plain.settings).map(obj);
  const extensions = arr(plain.extensions).map(obj);
  const databases = arr(plain.databases).map(obj);
  const replication = arr(plain.replication).map(obj);
  const connections = arr(plain.connections).map(obj);
  const hidden = ["server", "session", "database", "settings"].filter((k) => plain[k] == null);

  // encryption
  const ssl = session.ssl;
  const sslDetail = [str(session.ssl_version), str(session.ssl_cipher)].filter(Boolean).join(", ");

  // database activity
  const hit = num(db.blks_hit);
  const read = num(db.blks_read);
  const ratio = hit !== null && read !== null && hit + read > 0 ? hit / (hit + read) : null;
  const dbRows: Row[] = [
    ["Size", bytes(db.size)],
    ["Connections", count(db.connections)],
    ["Commits", count(db.xact_commit)],
    ["Rollbacks", count(db.xact_rollback)],
    ["Cache hit ratio", ratio !== null ? `${(ratio * 100).toFixed(2)}%` : null],
    ["Deadlocks", count(db.deadlocks)],
    ["Conflicts", count(db.conflicts)],
    ["Temp files", bytes(db.temp_bytes)],
  ];
  const tupRows: Row[] = [
    ["Returned", count(db.tup_returned)],
    ["Fetched", count(db.tup_fetched)],
    ["Inserted", count(db.tup_inserted)],
    ["Updated", count(db.tup_updated)],
    ["Deleted", count(db.tup_deleted)],
  ];

  // server
  const addr = str(server.server_addr);
  const port = str(server.server_port);
  const serverRows: Row[] = [
    ["Version", str(server.server_version)],
    ["Build", str(server.version)],
    ["Role", server.in_recovery === true ? "standby (in recovery)" : server.in_recovery === false ? "primary" : null],
    ["Address", addr ? `${addr}${port ? `:${port}` : ""}` : null],
    ["Started", when(server.started_at)],
    ["Uptime", formatUptime(num(server.uptime_secs))],
    ["Data directory", str(server.data_directory)],
  ];

  // session
  const user = str(session.user);
  const sessionUser = str(session.session_user);
  const attrs = [
    session.superuser === true && "superuser",
    session.create_db === true && "create db",
    session.create_role === true && "create role",
    session.replication === true && "replication",
  ].filter(Boolean) as string[];
  const sessionRows: Row[] = [
    ["Database", str(session.database)],
    ["Role", user],
    ["Session role", sessionUser && sessionUser !== user ? sessionUser : null],
    ["Attributes", session.superuser == null ? null : attrs.length ? attrs.join(", ") : "none"],
    ["Search path", str(session.search_path)],
    ["Time zone", str(session.timezone)],
    ["Encoding", str(session.encoding) ?? str(db.encoding)],
    ["Collation", str(db.collation)],
    ["Stats reset", when(db.stats_reset)],
  ];

  return (
    <>
      {ssl === true ? (
        <div className="warnbox ok">
          <ShieldCheck />
          <div>
            <b>Connection is encrypted</b>
            {sslDetail && <span className="mono text-[11.5px]"> ({sslDetail})</span>}
          </div>
        </div>
      ) : ssl === false ? (
        <div className="warnbox soft">
          <ShieldAlert />
          <div>
            <b>Connection is not encrypted</b> - traffic to this server is plain text. Add{" "}
            <span className="mono">sslmode=require</span> to the connection to insist on TLS.
          </div>
        </div>
      ) : null}

      <StatSection title={`Database${str(db.name) ? ` ${str(db.name)}` : ""}`} rows={dbRows} />
      <StatSection title="Rows (since stats reset)" rows={tupRows} five />

      {connections.length > 0 && (
        <StatSection
          title="Connections by state"
          rows={connections.map((c): Row => [str(c.state) ?? "unknown", count(c.count)])}
        />
      )}

      <Section title="Server" rows={serverRows} />
      <Section title="Session" rows={sessionRows} />

      {replication.length > 0 && (
        <Section
          title={`Replication · ${replication.length} standby${replication.length === 1 ? "" : "s"}`}
          rows={replication.map((r, i): Row => [
            str(r.application_name) ?? str(r.client) ?? `standby ${i + 1}`,
            [str(r.client), str(r.state), str(r.sync_state), str(r.replay_lag) && `lag ${str(r.replay_lag)}`]
              .filter(Boolean)
              .join(" · "),
          ])}
        />
      )}

      {settings.length > 0 && (
        <Section
          title="Settings"
          rows={settings.map((st): Row => [str(st.name) ?? "?", settingText(st.setting, st.unit) ?? "(empty)"])}
        />
      )}

      {extensions.length > 0 && (
        <Section title={`Extensions · ${extensions.length}`}>
          <div className="flex flex-wrap gap-1.5 px-[14px] py-3">
            {extensions.map((e) => (
              <span key={str(e.name) ?? ""} className="pill">
                {str(e.name)}
                {str(e.version) && <span className="text-text-3">{str(e.version)}</span>}
              </span>
            ))}
          </div>
        </Section>
      )}

      {databases.length > 0 && (
        <Section
          title="Databases on this server"
          rows={databases.map((d): Row => [
            str(d.name) ?? "?",
            <span key="v" className="inline-flex items-center gap-2">
              {str(d.name) === str(session.database) && <span className="pill acc">connected</span>}
              {bytes(d.size) ?? "-"}
            </span>,
          ])}
        />
      )}

      {hidden.length > 0 && (
        <p className="hint">
          Not shown: {hidden.join(", ")} - your role can't read those catalogs (common on managed providers).
        </p>
      )}
    </>
  );
}
