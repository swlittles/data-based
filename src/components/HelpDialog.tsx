import { useState, type ReactNode } from "react";
import { BookOpen, Boxes, Database, Keyboard, Search, ShieldCheck, Sparkles } from "lucide-react";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

const IS_MAC = navigator.platform.toUpperCase().includes("MAC");
const MOD = IS_MAC ? "⌘" : "Ctrl";
const SHIFT = IS_MAC ? "⇧" : "Shift";
const ENTER = IS_MAC ? "⏎" : "Enter";

// ---------------------------------------------------------------------------
// building blocks
// ---------------------------------------------------------------------------

function K({ children }: { children: ReactNode }) {
  return <kbd className="kbd">{children}</kbd>;
}

function Code({ children }: { children: ReactNode }) {
  return <code className="rounded-[4px] bg-panel-2 px-1 py-0.5 font-mono text-[0.9em] text-text">{children}</code>;
}

function Block({ children }: { children: string }) {
  return (
    <pre className="overflow-x-auto rounded-[var(--r-sm)] border border-line bg-panel px-3 py-2.5 font-mono text-[11.5px] leading-relaxed text-text">
      {children}
    </pre>
  );
}

function H({ children }: { children: ReactNode }) {
  return <h3 className="mb-2 mt-5 text-[13px] font-semibold text-text first:mt-0">{children}</h3>;
}

function P({ children }: { children: ReactNode }) {
  return <p className="mb-3 text-[12.5px] leading-relaxed text-text-2">{children}</p>;
}

function B({ children }: { children: ReactNode }) {
  return <b className="font-medium text-text">{children}</b>;
}

/** Labelled rows in a `.card` (label + description). */
function Rows({ rows }: { rows: [ReactNode, ReactNode][] }) {
  return (
    <div className="card">
      {rows.map(([l, r], i) => (
        <div key={i} className="row !py-[10px]">
          <div className="l">
            <b>{l}</b>
            <span>{r}</span>
          </div>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// sections
// ---------------------------------------------------------------------------

const SECTIONS = [
  { id: "overview", label: "Overview", icon: BookOpen },
  { id: "connections", label: "Connections", icon: Boxes },
  { id: "querying", label: "Querying", icon: Search },
  { id: "postgres", label: "PostgreSQL", icon: Database },
  { id: "ai", label: "AI and Studio", icon: Sparkles },
  { id: "safety", label: "Safety", icon: ShieldCheck },
  { id: "shortcuts", label: "Shortcuts", icon: Keyboard },
] as const;

type SectionId = (typeof SECTIONS)[number]["id"];

function Overview() {
  return (
    <>
      <H>The console</H>
      <P>
        Data Based is one window with five parts. Everything is reachable with the mouse; the shortcuts on the last page
        get you there faster.
      </P>
      <Rows
        rows={[
          [
            "Rail",
            <>
              The thin column on the far left. Colour-tagged tiles for every saved connection (click to connect or
              switch, several can be live at once) and, below, the sections for the current workspace.
            </>,
          ],
          [
            "Picker",
            <>
              Database button, one search box that filters collections and fields, then <B>Open</B> tabs,{" "}
              <B>Pinned</B> collections, <B>Collections</B> and <B>Saved queries</B>. Toggle it with <K>{MOD} B</K>;
              drag its edge to resize.
            </>,
          ],
          [
            "Canvas",
            <>
              The collection tab. A title with a stat strip (documents, size, indexes), then the views:{" "}
              <B>Table</B>, <B>Documents</B>, <B>Schema</B>, <B>Aggregate</B>, <B>Indexes</B> and, in advanced
              mode, <B>Shell</B>. The <B>dock</B> at the bottom is the query transport: filter, sort, projection,
              run, explain, save.
            </>,
          ],
          [
            "Drawer",
            <>
              Slides in from the right when you open or insert a document. Three tabs: <B>Fields</B> (typed inline
              editing that keeps BSON types), <B>JSON</B> (full editor in shell syntax) and <B>Diff</B> against the
              loaded document.
            </>,
          ],
          [
            "Status bar",
            <>
              Connection, database and the <B>write-mode switch</B>. Read-only workspaces show a lock; click it to
              enter edit mode for this session.
            </>,
          ],
        ]}
      />
    </>
  );
}

function Connections() {
  return (
    <>
      <H>Saved profiles</H>
      <P>
        A connection is a saved profile: URI or host, credentials, an optional colour tag that paints its rail tile,
        and a session mode. Connect from the rail; the workspace remembers its open tabs and picker state between
        launches, and reconnects on start.
      </P>
      <H>Session modes</H>
      <div className="opts">
        <div className="opt cursor-default">
          <b>
            <span className="pill ok mr-1.5">rw</span>Read &amp; write
          </b>
          <span>Everything is enabled. The default for local and development servers.</span>
        </div>
        <div className="opt cursor-default">
          <b>
            <span className="pill warn mr-1.5">ro</span>Read-only
          </b>
          <span>Writes are blocked in the backend for the whole session. Browse and query freely.</span>
        </div>
        <div className="opt cursor-default">
          <b>
            <span className="pill dgr mr-1.5">prod</span>Production
          </b>
          <span>Opens read-only every time. Edit mode is an explicit switch in the status bar and asks first.</span>
        </div>
      </div>
      <H>Credentials</H>
      <P>
        Passwords are AES-256-GCM encrypted at rest. The master key lives in your OS keychain, or in a private key
        file next to the app data if you turn the keychain off in Settings. It never leaves the machine, so a copied
        connections file cannot be decrypted elsewhere.
      </P>
      <H>Import and export</H>
      <Rows
        rows={[
          ["Export without secrets", "A portable file with hosts, options and tags only. Safe to share; passwords are re-entered on import."],
          [
            "Encrypted export",
            "Includes credentials, re-encrypted under a passphrase you choose (Argon2id + AES-256). There is no recovery without the passphrase.",
          ],
          ["Import", "Pick a file; encrypted ones ask for the passphrase. Everything comes in as new profiles, existing ones are untouched."],
          ["Copy connection string", "From a tile's menu, with or without the password, ready for mongosh or psql."],
        ]}
      />
    </>
  );
}

function Querying() {
  return (
    <>
      <H>The dock</H>
      <P>
        Type a filter in the dock and press <K>{MOD} {ENTER}</K> (or <K>{ENTER}</K> inside the field). The dock uses
        shell syntax, so unquoted keys, <Code>ObjectId()</Code>, <Code>ISODate()</Code> and every{" "}
        <Code>$operator</Code> work as they do in mongosh. Sort and projection have their own fields; the strip above
        the input shows <B>matched</B> count, <B>timing</B> and the <B>winning plan</B> (a collection scan is
        highlighted).
      </P>
      <Block>{`{ status: "active", createdAt: { $gte: ISODate("2025-01-01") } }
{ _id: ObjectId("66f0c2a1e4b0f5c8d9a1b2c3") }
{ tags: { $in: ["beta", "vip"] }, "profile.age": { $gt: 30 } }`}</Block>
      <Rows
        rows={[
          ["Explain", "Runs the same query with explain and shows the plan tree, stage timings and index usage."],
          ["Saved queries", "Save the current filter, sort and projection under a name; they live in the picker under Saved queries and open with one click."],
          ["Table vs Documents", "Table flattens documents into sortable columns for scanning; Documents shows each one as a tree and is where you edit."],
        ]}
      />
      <H>Aggregate</H>
      <P>
        The pipeline builder holds one editor per stage. Toggle a stage off to skip it, drag to reorder, and use{" "}
        <B>preview</B> to see the output of the pipeline up to that stage. Stage stats show document counts, drop-off
        and timing per stage so you can see where a pipeline gets slow.
      </P>
      <H>Shell (advanced)</H>
      <P>
        Turn on <B>Advanced mode</B> in Settings to add the Shell view. It runs one statement at a time with the full
        extended syntax and method chaining; press <K>{MOD} {ENTER}</K> to run.
      </P>
      <Block>{`db.orders.aggregate([
  { $match: { createdAt: { $gte: ISODate("2025-01-01") } } },
  { $group: { _id: "$status", count: { $sum: 1 } } },
  { $sort: { count: -1 } }
])`}</Block>
    </>
  );
}

function Postgres() {
  return (
    <>
      <H>MongoDB words, PostgreSQL things</H>
      <P>
        A PostgreSQL connection uses the same console. The picker lists <B>schemas</B> instead of databases and{" "}
        <B>tables</B>, views, materialized views and foreign tables instead of collections; each row is shown as a
        plain JSON object. A connection is bound to one database (the one in the URI); switch schemas from the picker.
      </P>
      <H>SQL in the dock</H>
      <P>
        The query boxes take SQL fragments: the filter is a <Code>WHERE</Code> condition, sort is an{" "}
        <Code>ORDER BY</Code> list and projection is a column list. Leave a box empty for no clause. <B>Build</B>{" "}
        writes the condition for you.
      </P>
      <Block>{`status = 'paid' AND total > 100
email ILIKE '%@example.com' AND deleted_at IS NULL
meta->>'plan' = 'pro' AND created_at > now() - interval '7 days'
id IN (7, 12, 31)`}</Block>
      <Rows
        rows={[
          ["Explain", "EXPLAIN (ANALYZE) of the same query: plan nodes, sequential scans, planning and execution time."],
          ["Bulk update", <>A <Code>SET</Code> list such as <Code>status = 'archived', updated_at = now()</Code>, applied to every row matching the filter.</>],
          ["Import and export", "JSON, NDJSON and CSV (header row = column names, empty cell = column default). There is no BSON for rows."],
          ["Copy, duplicate, diff", "Copy and diff work between any two open PostgreSQL connections. Diff and sync match rows by primary key."],
        ]}
      />
      <H>SQL shell (advanced)</H>
      <P>
        The Shell view runs SQL. Statements run one after another like psql, and the last one that returns rows is
        shown in the grid. Press <K>{MOD} {ENTER}</K> to run.
      </P>
      <Block>{`SELECT status, count(*) AS n, sum(total) AS revenue
FROM orders
WHERE created_at > now() - interval '30 days'
GROUP BY status
ORDER BY n DESC;`}</Block>
      <H>Editing rows</H>
      <P>
        Rows are addressed by their <B>primary key</B>. Tables without one can be browsed, queried and exported, but
        single rows can't be edited or deleted, and they can't be diffed. Views and materialized views are read-only.
        Identity, generated and defaulted columns are filled in by the database on insert.
      </P>
      <H>Read-only, for real</H>
      <P>
        Read-only and production workspaces run every statement inside a <Code>BEGIN READ ONLY</Code> transaction that
        is rolled back afterwards, so PostgreSQL itself refuses writes, including writes hidden in functions. Studio
        queries run the same way.
      </P>
      <H>Connecting</H>
      <P>
        Any PostgreSQL server or wire-compatible service works: Neon, Supabase, Tiger Cloud / Timescale, Amazon RDS
        and Aurora, PlanetScale Postgres, Google Cloud SQL and AlloyDB, Azure Database for PostgreSQL, Crunchy Bridge,
        Render, Railway, or your own server. Paste the provider's <Code>postgresql://</Code> URI or fill in the form.
      </P>
      <Rows
        rows={[
          [
            <Code>sslmode</Code>,
            <>
              <Code>disable</Code>, <Code>prefer</Code> (the default), <Code>require</Code> (encrypted, certificate not
              checked), <Code>verify-ca</Code> and <Code>verify-full</Code> (checked against the system roots or a CA
              file you pick). Hosted providers usually want <Code>require</Code> or stricter.
            </>,
          ],
          ["Poolers", "Transaction-mode poolers (PgBouncer, Supavisor, Neon's pooled endpoint) work: no named prepared statements are used."],
          ["SSH tunnels", "The same bastion settings as MongoDB connections."],
        ]}
      />
    </>
  );
}

function Ai() {
  return (
    <>
      <H>Studio</H>
      <P>
        Open <B>Studio</B> from the rail (<K>{MOD} J</K>) and ask a question in plain English. The model writes a
        read-only query, Data Based runs it and shows the rows with a bar, line or single-number chart. Pick one
        collection, or <B>Whole database</B> to let the model choose collections and join them.
      </P>
      <Rows
        rows={[
          ["Follow-ups", "Keep asking in the same chat; earlier questions and their queries are sent as context."],
          ["Saved questions", "Hover a question and pin it. Rerunning asks again, so the query is rebuilt against today's schema and data."],
          ["Open in Shell", "Every answer shows its query. Open it in the shell to tweak it, copy it, or run it as a starting point."],
          ["Summarize", "A plain-language reading of the result rows."],
          ["Normal / Deep think", "Deep think asks the model to reason before answering: slower, better for joins and vague questions."],
        ]}
      />
      <H>Assist in the shell and explain plans</H>
      <P>
        The <B>AI</B> menu in the shell fixes, optimizes, explains or adds safety limits to the statement in the editor,
        or applies any change you describe. Suggestions are only applied when you press <B>Apply</B>. The explain sheet
        has <B>Ask AI to read this plan</B> for a verdict and the one fix that matters most.
      </P>
      <H>OpenRouter and your data</H>
      <P>
        AI features use your own OpenRouter key (Settings &gt; AI), stored encrypted like connection passwords. Pick any
        model OpenRouter offers; <B>openrouter/auto</B> chooses one per request. Nothing is sent until you use an AI
        feature. Collection and field names (table and column names for PostgreSQL) are always sent; one sample document per collection and result rows are sent
        only while <B>Share sample data</B> is on.
      </P>
      <div className="notice acc mt-3">
        <ShieldCheck />
        <span>
          Studio never writes. Write requests are refused, and the backend rejects $out and $merge on Studio queries no
          matter what the model returns. On PostgreSQL, Studio runs a single SELECT inside a READ ONLY transaction.
        </span>
      </div>
    </>
  );
}

function Safety() {
  return (
    <>
      <H>Guard rails</H>
      <P>Data Based assumes the database in front of you matters. Destructive actions are slow on purpose.</P>
      <Rows
        rows={[
          ["Drop and clear", "Dropping a database or collection, or clearing a collection, asks you to type its name and offers an export first. The same goes for PostgreSQL tables and views."],
          ["Multi-document delete", "Deleting several documents offers a JSON backup before anything is removed (Settings > Safety)."],
          ["Read-only workspaces", "Writes are refused at the API layer, not just hidden in the UI. Read-only and production sessions cannot write until you flip the status bar switch."],
          ["Production edit mode", "Leaving read-only on a production connection asks for confirmation and lasts for the session only."],
        ]}
      />
      <div className="notice acc mt-3">
        <ShieldCheck />
        <span>
          No account, no telemetry and no cloud: connections, saved queries and settings are local files. The only
          outside service is OpenRouter, and only when you use an AI feature.
        </span>
      </div>
    </>
  );
}

function Shortcuts() {
  const rows: [ReactNode, string][] = [
    [<K>{MOD} K</K>, "Find anything: collections, fields, actions"],
    [<K>{MOD} O</K>, "Open a collection"],
    [<K>{MOD} N</K>, "Insert a document in the current collection"],
    [<K>{MOD} W</K>, "Close the current tab"],
    [<K>{MOD} B</K>, "Toggle the picker"],
    [<K>{MOD} J</K>, "Open or close Studio"],
    [<K>{MOD} {ENTER}</K>, "Run the current query or pipeline"],
    [<K>{MOD} S</K>, "Save the document in the drawer"],
    [<K>{MOD} ,</K>, "Settings"],
    [<K>{MOD} {SHIFT} T</K>, "Cycle theme"],
    [<K>Esc</K>, "Close the drawer, clear the search, dismiss dialogs"],
  ];
  return (
    <>
      <H>Keyboard</H>
      <div className="card">
        {rows.map(([keys, desc], i) => (
          <div key={i} className="row !py-[9px]">
            <span className="text-[12.5px] text-text-2">{desc}</span>
            <span className="rr">{keys}</span>
          </div>
        ))}
      </div>
      <P>
        <span className="mt-3 block" />
        Right-click a connection tile, a collection or a document for its menu. Middle-click a tab to close it.
      </P>
    </>
  );
}

const RENDER: Record<SectionId, () => ReactNode> = {
  overview: Overview,
  connections: Connections,
  querying: Querying,
  postgres: Postgres,
  ai: Ai,
  safety: Safety,
  shortcuts: Shortcuts,
};

// ---------------------------------------------------------------------------
// dialog
// ---------------------------------------------------------------------------

export function HelpDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const [active, setActive] = useState<SectionId>("overview");
  const Body = RENDER[active];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="h-[80vh] max-w-[860px]">
        <DialogHeader>
          <DialogTitle>Help</DialogTitle>
          <DialogDescription>how the console fits together · connections · querying · PostgreSQL · safety · keys</DialogDescription>
        </DialogHeader>
        <DialogBody className="flex-row gap-0 overflow-hidden p-0 pt-0">
          <nav className="no-select flex w-[176px] shrink-0 flex-col gap-[2px] border-r border-line px-2 py-2">
            {SECTIONS.map((s) => (
              <button
                key={s.id}
                type="button"
                onClick={() => setActive(s.id)}
                className={cn("it", active === s.id && "on")}
                aria-current={active === s.id ? "page" : undefined}
              >
                <s.icon />
                <span className="text-[12.5px] font-medium">{s.label}</span>
              </button>
            ))}
          </nav>
          <div className="min-h-0 flex-1 overflow-auto px-6 py-5">
            <Body />
          </div>
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
