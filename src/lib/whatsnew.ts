/**
 * What's New content, shown once per app version on first launch (tracked in
 * localStorage) and reopenable any time from the About dialog.
 *
 * Release checklist: when shipping a new version, replace/extend SLIDES with
 * that release's highlights. The version gate keys off the app version at
 * runtime, so content just needs to describe the current release.
 */

export interface WhatsNewSlide {
  /** Release the slide belongs to, shown as a mono pill. */
  version: string;
  title: string;
  tagline: string;
  points: string[];
}

const SEEN_KEY = "mongo-bongo-whats-new-seen";

export const SLIDES: WhatsNewSlide[] = [
  {
    version: "0.2.2",
    title: "Charts, spreadsheets, any model",
    tagline: "More ways to see an answer, and to take it with you.",
    points: [
      "Studio charts: columns, stacked bars, area, donut, scatter and heatmaps, plus several series in one chart",
      "The chart menu only offers the forms your result fits; big series lists fold into \"Other\"",
      "Export to Excel (.xlsx) with real numbers and dates - collections, tables, Studio results and overviews",
      "Export to Apple Numbers (.numbers) on a Mac with Numbers installed",
      "Paste an exact OpenRouter model id in Settings > AI; unknown models fall back to openrouter/auto",
    ],
  },
  {
    version: "0.2.0",
    title: "PostgreSQL",
    tagline: "Mongo Bongo now speaks PostgreSQL too - same console, same guard rails.",
    points: [
      "Connect to any Postgres: Neon, Supabase, Tiger Cloud, RDS / Aurora, PlanetScale, Cloud SQL, Azure, your own server",
      "Schemas and tables in the picker; rows in the Table and Documents views, edited by primary key",
      "SQL in the dock: WHERE, ORDER BY and column lists, plus a visual WHERE builder",
      "A SQL shell, EXPLAIN ANALYZE plans, indexes (btree, gin, gist, brin, hnsw...) and schema view",
      "Read-only and production workspaces run inside READ ONLY transactions, so the server refuses writes",
      "Import and export JSON, NDJSON and CSV; copy, duplicate and diff tables between Postgres connections",
      "Studio writes read-only SQL and charts the answer",
    ],
  },
  {
    version: "0.1.0",
    title: "Mongo Bongo",
    tagline: "First build.",
    points: [
      "Table, Documents, Schema and Indexes views for any collection",
      "Query dock with Find, Aggregate and Shell",
      "Document drawer with typed field editing, a JSON editor and a diff view",
      "Production connections open read-only; edit mode is an explicit switch",
      "Credentials encrypted at rest, optionally keyed from the OS keychain",
      "Studio: ask questions in plain English, get read-only queries and charts (bring your own OpenRouter key)",
      "AI assist in the shell and explain plans: fix, optimize, explain, suggest indexes",
      "SSH tunnels and a database overview with storage, index and reference insights",
    ],
  },
];

/** Version whose What's New the user has already seen (or dismissed). */
export function seenVersion(): string | null {
  return localStorage.getItem(SEEN_KEY);
}

export function markSeen(version: string): void {
  localStorage.setItem(SEEN_KEY, version);
}
