import type { Engine } from "@/lib/api";
import { shortType } from "@/lib/engine";
import { api, writeGuard } from "@/lib/api";
import { AI_NOT_READY, useAi } from "@/stores/ai";

/**
 * Prompt library for every AI feature: Studio (question -> read-only query ->
 * chart), query assist in the shell, and explain-plan reading. All calls go
 * through the backend's OpenRouter proxy with the model + mode from settings.
 * PostgreSQL workspaces get SQL prompts: Studio writes one read-only SELECT
 * (run through api.sqlQuery, which the backend checks and runs READ ONLY).
 */

export interface TokenUsage {
  input: number;
  output: number;
  total: number;
  /** OpenRouter credits, summed when reported. */
  cost: number;
}

export const ZERO_USAGE: TokenUsage = { input: 0, output: 0, total: 0, cost: 0 };

export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return { input: a.input + b.input, output: a.output + b.output, total: a.total + b.total, cost: a.cost + b.cost };
}

async function chat(system: string, user: string, jsonMode: boolean): Promise<{ text: string; usage: TokenUsage }> {
  const { model, mode, configured } = useAi.getState();
  if (!configured) throw new Error(AI_NOT_READY);
  const res = await api.aiChat({ model, system, user, jsonMode, reasoning: mode === "deep" });
  return {
    text: res.content,
    usage: { input: res.inputTokens, output: res.outputTokens, total: res.totalTokens, cost: res.cost ?? 0 },
  };
}

/** Pull the JSON object out of a reply, tolerating markdown fences or prose. */
export function extractJson(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = (fenced ? fenced[1] : text).trim();
  const start = candidate.search(/[[{]/);
  if (start < 0) return candidate;
  const open = candidate[start];
  const end = candidate.lastIndexOf(open === "{" ? "}" : "]");
  return end > start ? candidate.slice(start, end + 1) : candidate.slice(start);
}

function parseJson<T>(text: string): T {
  try {
    return JSON.parse(extractJson(text)) as T;
  } catch {
    throw new Error("The model did not return valid JSON - try again or switch model");
  }
}

// ---------------------------------------------------------------------------
// Studio: question -> plan
// ---------------------------------------------------------------------------

export type ChartKind = "bar" | "line" | "number";

export interface VizPlan {
  /** "sql" = PostgreSQL: one read-only SELECT in `sql`. */
  kind: "find" | "aggregate" | "sql";
  /** Collection the query runs on (required in whole-database mode). For SQL,
   *  the primary table the query reads (names the shell tab). */
  collection?: string;
  sql?: string;
  filter?: string;
  sort?: string;
  projection?: string;
  limit?: number;
  stages?: { op: string; body: string }[];
  chart?: { type: ChartKind; labelField: string; valueField: string; title?: string } | null;
  explanation: string;
  /** A follow-up that has nothing to do with the conversation so far. */
  unrelatedToConversation?: boolean;
  /** The request asked to change data; Studio is read-only, so it is refused. */
  writeIntent?: boolean;
}

/** Collection name -> sampled field paths. */
export type DbSchema = Record<string, string[]>;

export interface VizHistoryItem {
  prompt: string;
  query?: string;
}

/** A PostgreSQL table as the model sees it: typed columns, keys, real FKs. */
export interface SqlTable {
  kind?: string;
  columns: { name: string; type: string }[];
  primaryKey: string[];
  /** Foreign keys: local column(s) -> referenced table. */
  refs: { field: string; to: string }[];
}

/** Table name -> description. */
export type SqlSchema = Record<string, SqlTable>;

export interface VizRequest {
  /** Defaults to mongo; "postgres" asks for one SQL SELECT. */
  engine?: Engine;
  prompt: string;
  database: string;
  /** Single-collection mode. */
  collection?: string;
  fields?: string[];
  /** Whole-database mode: chosen collections and one sample document each. */
  schema?: DbSchema;
  samples?: Record<string, unknown>;
  /** PostgreSQL: the tables the query may use (the scoped table and its FK
   *  targets, or the chosen tables in whole-schema mode). */
  tables?: SqlSchema;
  history?: VizHistoryItem[];
}

/** Aggregation stages that write. Never allowed from Studio (the backend
 *  rejects them too). */
export const WRITE_STAGES = ["$out", "$merge"];

export const RESULT_LIMIT = 500;

const PLAN_SHAPE = `{
  "kind": "find" | "aggregate",
  "collection": "name",           // whole-database mode only: the collection .aggregate() runs on
  "filter": "{ ... }",            // find only, MongoDB filter as a string
  "sort": "{ ... }",              // optional
  "projection": "{ ... }",        // optional
  "limit": 100,                   // optional, max ${RESULT_LIMIT}
  "stages": [{ "op": "$match", "body": "{ ... }" }],   // aggregate only
  "chart": { "type": "bar" | "line" | "number", "labelField": "...", "valueField": "...", "title": "..." } | null,
  "explanation": "one short sentence describing what the query does",
  "unrelatedToConversation": false,
  "writeIntent": false
}`;

const COMMON_RULES = `- READ-ONLY. If the request asks to change data (insert, add, create, update, edit, set, replace, delete, remove, drop, rename, or anything mutating), do not write a query: set "writeIntent": true and leave the query fields empty. Reading, counting, filtering and aggregating are fine.
- Never emit $out, $merge or any stage that writes.
- If a "Conversation so far" section is present and this request is a fresh, unrelated topic, set "unrelatedToConversation": true.
- Charts: "bar" compares a metric across categories, "line" shows a metric over time (sort by the time field ascending), "number" is a single headline value (one result row). Use null when raw documents answer better. Project the label into a named field (or _id) and the numeric metric into another, then set chart.labelField / chart.valueField to those exact output names.
- All filter / sort / projection / stage bodies are STRINGS of MongoDB JSON; ObjectId(...), ISODate(...) and unquoted keys are allowed.
- Always include a $limit stage (or "limit") of at most ${RESULT_LIMIT}.
- Only use fields that appear in the provided fields or sample documents.`;

const PLAN_SYSTEM_SINGLE = `You turn natural-language questions into read-only MongoDB queries for a data studio.
Respond with ONLY a JSON object, no prose, shaped as:
${PLAN_SHAPE}
Rules:
${COMMON_RULES}
- Prefer "aggregate" whenever grouping, counting or averaging is involved.`;

const PLAN_SYSTEM_MULTI = `You turn natural-language questions into read-only MongoDB aggregations that may span MULTIPLE collections of one database, for a data studio.
You get the relevant collections, their sampled fields and (when available) one real sample document each. Study the samples first to learn field types and how collections reference each other, then pick the primary collection and join the others with $lookup.
Respond with ONLY a JSON object, no prose, shaped as:
${PLAN_SHAPE}
Rules:
${COMMON_RULES}
- "kind" is "aggregate" and "collection" is REQUIRED: a real collection name from the schema.
- Entity matching: when the question names an entity (users, orders, products), use the collection whose NAME matches it (singular/plural/obvious synonyms). Never substitute a look-alike collection that merely shares fields.
- The primary is usually the collection holding the records being measured (orders, events, transactions). Join the named entity to it through a field referencing its _id.
- Joins can be multi-hop: if the primary has no field for the asked dimension, follow the chain (orders.community -> communities._id, communities.city -> cities._id), one $lookup (+ $unwind) per hop.
- A field named like an entity (user, userId, community) references the collection named after it.`;

function schemaBlock(schema: DbSchema): string {
  return Object.entries(schema)
    .slice(0, 60)
    .map(([name, fields]) => `- ${name}: ${fields.slice(0, 50).join(", ") || "(fields not sampled)"}`)
    .join("\n");
}

function samplesBlock(samples?: Record<string, unknown>, engine: Engine = "mongo"): string {
  if (!samples || Object.keys(samples).length === 0) return "";
  const blocks = Object.entries(samples)
    .map(([name, doc]) => `${name}:\n${JSON.stringify(doc).slice(0, 1200)}`)
    .join("\n\n");
  return engine === "postgres"
    ? `\n\nSample rows per table (study value formats):\n${blocks}`
    : `\n\nOne sample document per collection (study types and references):\n${blocks}`;
}

function historyBlock(history?: VizHistoryItem[]): string {
  if (!history?.length) return "";
  const lines = history
    .slice(-6)
    .map((h) => `User: ${h.prompt}${h.query ? `\nQuery: ${h.query}` : ""}`)
    .join("\n");
  return `\n\nConversation so far (for follow-up context):\n${lines}`;
}

const SELECT_SYSTEM = `You pick which MongoDB collections are needed to answer a question. You get EVERY collection of one database with its sampled fields.
Respond with ONLY JSON: { "collections": ["primary", "join1", ...] }.
Rules:
- 1 to 6 names, PRIMARY first: the collection storing the records being measured (orders, carts, transactions, events).
- Map nouns in the question to collections by NAME (singular/plural/synonyms). Never pick a look-alike over a real name match.
- Trace reference chains through the fields and include every bridge collection (orders -> communities -> cities for "orders per city" when orders only has "community").
- Only names from the provided list.`;

/** Whole-database step 1: pick the relevant collections, bridges included. */
export async function selectCollections(args: {
  engine?: Engine;
  prompt: string;
  database: string;
  schema: DbSchema;
  /** PostgreSQL: typed columns and foreign keys for every table. */
  tables?: SqlSchema;
}): Promise<{ collections: string[]; usage: TokenUsage }> {
  const pg = args.engine === "postgres";
  const user = pg
    ? `Schema: ${args.database}\nQuestion: ${args.prompt}\n\nTables:\n${sqlSchemaBlock(args.tables ?? tablesFromFields(args.schema))}`
    : `Database: ${args.database}\nQuestion: ${args.prompt}\n\nCollections and their fields:\n${schemaBlock(args.schema)}`;
  const { text, usage } = await chat(pg ? SELECT_SYSTEM_SQL : SELECT_SYSTEM, user, true);
  const parsed = parseJson<{ collections?: unknown }>(text);
  const valid = new Set(Object.keys(args.schema));
  const picked = Array.isArray(parsed.collections)
    ? parsed.collections.filter((c): c is string => typeof c === "string" && valid.has(c))
    : [];
  return { collections: picked.slice(0, 6), usage };
}

/** Normalize a model's plan: string bodies, legacy chart types, write detection. */
export function normalizePlan(plan: VizPlan, multi: boolean, engine: Engine = "mongo"): VizPlan {
  if (engine === "postgres") return normalizeSqlPlan(plan);
  const out: VizPlan = { ...plan };
  if (out.stages) {
    out.stages = out.stages.map((s) => ({
      op: String(s.op).trim(),
      body: typeof s.body === "string" ? s.body : JSON.stringify(s.body),
    }));
  }
  if (out.chart) {
    const t = String(out.chart.type);
    out.chart = { ...out.chart, type: t === "line" || t === "number" ? t : "bar" };
    if (!out.chart.labelField && out.chart.type !== "number") out.chart = null;
  }
  const writes = out.stages?.some((s) => WRITE_STAGES.includes(s.op.toLowerCase()));
  if (out.writeIntent || writes) return { ...out, writeIntent: true };
  if (out.kind !== "find" && out.kind !== "aggregate") {
    throw new Error("The model returned an unusable plan - try rephrasing");
  }
  if (out.kind === "aggregate" && !out.stages?.length) {
    throw new Error("The model returned an empty pipeline - try rephrasing");
  }
  if (multi && !out.collection) {
    throw new Error("The model did not pick a collection to run on - try rephrasing");
  }
  return out;
}

export async function generateVizPlan(req: VizRequest): Promise<{ plan: VizPlan; usage: TokenUsage }> {
  if (req.engine === "postgres") return generateSqlPlan(req);
  const multi = Boolean(req.schema);
  const context = multi
    ? `Database: ${req.database}\nCollections and their fields:\n${schemaBlock(req.schema!)}${samplesBlock(req.samples)}`
    : `Database: ${req.database}\nCollection: ${req.collection}\nKnown fields (sampled): ${
        (req.fields ?? []).slice(0, 80).join(", ") || "(unknown)"
      }`;
  const user = `${context}${historyBlock(req.history)}\n\nRequest: ${req.prompt}`;
  const { text, usage } = await chat(multi ? PLAN_SYSTEM_MULTI : PLAN_SYSTEM_SINGLE, user, true);
  return { plan: normalizePlan(parseJson<VizPlan>(text), multi), usage };
}

/** Render a plan as a copy-pastable mongosh statement. */
export function planToShell(plan: VizPlan, collection: string): string {
  if (plan.kind === "sql") return `${plan.sql ?? ""};`;
  const coll = /^[A-Za-z_][\w]*$/.test(collection) ? `db.${collection}` : `db.getCollection(${JSON.stringify(collection)})`;
  if (plan.kind === "aggregate" && plan.stages?.length) {
    const stages = plan.stages.map((s) => `  { ${s.op}: ${s.body.trim()} }`).join(",\n");
    return `${coll}.aggregate([\n${stages}\n])`;
  }
  let out = `${coll}.find(${plan.filter?.trim() || "{}"}`;
  if (plan.projection?.trim()) out += `, ${plan.projection.trim()}`;
  out += ")";
  if (plan.sort?.trim()) out += `.sort(${plan.sort.trim()})`;
  out += `.limit(${Math.min(plan.limit ?? 100, RESULT_LIMIT)})`;
  return out;
}

export const findLimit = (plan: VizPlan) => Math.max(1, Math.min(plan.limit ?? 100, RESULT_LIMIT));

// ---------------------------------------------------------------------------
// Studio: question -> SQL (PostgreSQL)
// ---------------------------------------------------------------------------

const SQL_PLAN_SHAPE = `{
  "kind": "sql",
  "sql": "SELECT ...",            // ONE PostgreSQL query, no trailing semicolon
  "collection": "table",          // the primary table the query reads from
  "chart": { "type": "bar" | "line" | "number", "labelField": "...", "valueField": "...", "title": "..." } | null,
  "explanation": "one short sentence describing what the query does",
  "unrelatedToConversation": false,
  "writeIntent": false
}`;

const SQL_RULES = `- READ-ONLY. If the request asks to change data (insert, add, create, update, edit, set, replace, delete, remove, drop, rename, or anything mutating), do not write a query: set "writeIntent": true and leave "sql" empty. Reading, counting, filtering and aggregating are fine.
- Exactly ONE statement starting with SELECT or WITH. Never INSERT / UPDATE / DELETE / MERGE / TRUNCATE / DDL, SELECT ... INTO, FOR UPDATE / FOR SHARE, data-modifying CTEs, or side-effect functions (pg_sleep, set_config, dblink, pg_read_file, lo_export, pg_terminate_backend, ...).
- The schema is on the search_path: write table names unqualified, exactly as listed (tables from another schema are listed as schema.table). Double-quote identifiers that are not plain lower-case.
- Only use tables and columns that are listed. Join along the listed foreign keys (FK: col -> table(pk)).
- Joins, CTEs, aggregates (COUNT, SUM, AVG, GROUP BY, HAVING), FILTER clauses and window functions are all fine. Prefer aggregating in SQL over returning raw rows.
- Give every computed output column a simple snake_case alias with AS.
- Charts: "bar" compares a metric across categories, "line" shows a metric over time (ORDER BY the time bucket ascending), "number" is a single headline value (one result row). Use null when raw rows answer better. chart.labelField / chart.valueField are EXACT output column names (aliases).
- Time buckets: label them with to_char(date_trunc('day', col), 'YYYY-MM-DD') (or 'YYYY-MM', ...) so labels read cleanly. Round averages and ratios: round(avg(x)::numeric, 2).
- Row lists and grouped results end with LIMIT ${RESULT_LIMIT} or less.
- If a "Conversation so far" section is present and this request is a fresh, unrelated topic, set "unrelatedToConversation": true.`;

const SQL_SYSTEM_SINGLE = `You turn natural-language questions into a read-only PostgreSQL SELECT for a data studio.
You get the table in scope with its typed columns, primary key and foreign keys, plus the tables it references.
Respond with ONLY a JSON object, no prose, shaped as:
${SQL_PLAN_SHAPE}
Rules:
${SQL_RULES}
- Query the table in scope; join a referenced table only when the question needs its columns.`;

const SQL_SYSTEM_MULTI = `You turn natural-language questions into a read-only PostgreSQL SELECT that may join SEVERAL tables of one schema, for a data studio.
You get the relevant tables with typed columns, primary keys and real foreign keys, and (when available) a sample row or two each.
Respond with ONLY a JSON object, no prose, shaped as:
${SQL_PLAN_SHAPE}
Rules:
${SQL_RULES}
- Entity matching: when the question names an entity (users, orders, products), use the table whose NAME matches it (singular/plural/obvious synonyms). Never substitute a look-alike table that merely shares columns.
- The primary table ("collection") is usually the one holding the records being measured (orders, events, transactions).
- Joins can be multi-hop through bridge tables: follow the foreign keys, one JOIN per hop. Use LEFT JOIN when rows without a match must still count (e.g. "users with no orders").`;

const SELECT_SYSTEM_SQL = `You pick which PostgreSQL tables are needed to answer a question. You get EVERY table of one schema with its columns and foreign keys.
Respond with ONLY JSON: { "collections": ["primary", "join1", ...] }.
Rules:
- 1 to 6 names, PRIMARY first: the table storing the records being measured (orders, carts, transactions, events).
- Map nouns in the question to tables by NAME (singular/plural/synonyms). Never pick a look-alike over a real name match.
- Follow foreign keys and include every bridge table (orders -> communities -> cities for "orders per city" when orders only references communities).
- Only names from the provided list.`;

/** Shorter spellings of verbose SQL type names (fewer tokens, same meaning). */
export { shortType } from "@/lib/engine";

/** Degraded description when only column names are known. */
function tablesFromFields(schema: DbSchema): SqlSchema {
  const out: SqlSchema = {};
  for (const [name, fields] of Object.entries(schema)) {
    out[name] = { columns: fields.map((f) => ({ name: f, type: "" })), primaryKey: [], refs: [] };
  }
  return out;
}

/** `- orders [view] (id integer PK, total numeric) FK: customer_id -> customers(id)` */
export function sqlSchemaBlock(tables: SqlSchema): string {
  return Object.entries(tables)
    .slice(0, 60)
    .map(([name, t]) => {
      const cols = t.columns
        .slice(0, 50)
        .map((c) => `${c.name}${c.type ? ` ${shortType(c.type)}` : ""}${t.primaryKey.length === 1 && t.primaryKey[0] === c.name ? " PK" : ""}`)
        .join(", ");
      const kind = t.kind && t.kind !== "table" && t.kind !== "partitioned" ? ` [${t.kind}]` : "";
      const pk = t.primaryKey.length > 1 ? ` PK (${t.primaryKey.join(", ")})` : "";
      const fks = t.refs.map((r) => {
        const target = tables[r.to]?.primaryKey;
        return `${r.field} -> ${r.to}${target?.length ? `(${target.join(", ")})` : ""}`;
      });
      return `- ${name}${kind} (${cols || "columns unknown"})${pk}${fks.length ? ` FK: ${fks.join("; ")}` : ""}`;
    })
    .join("\n");
}

/**
 * Same-length copy of SQL with comments blanked and the insides of string
 * literals, quoted identifiers and dollar-quoted bodies replaced by spaces
 * (delimiters kept). Keyword and semicolon checks then only see code.
 */
export function maskSql(sql: string): string {
  const out = sql.split("");
  const blank = (from: number, to: number) => {
    for (let k = from; k < to; k++) if (out[k] !== "\n") out[k] = " ";
  };
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    const next = sql[i + 1];
    if (c === "-" && next === "-") {
      const end = sql.indexOf("\n", i);
      const stop = end < 0 ? sql.length : end;
      blank(i, stop);
      i = stop;
    } else if (c === "/" && next === "*") {
      const end = sql.indexOf("*/", i + 2);
      const stop = end < 0 ? sql.length : end + 2;
      blank(i, stop);
      i = stop;
    } else if (c === "'" || c === '"') {
      // '' / "" inside a literal is an escaped quote; E'..' also allows \'.
      const escapes = c === "'" && /[eE]/.test(sql[i - 1] ?? "") && !/\w/.test(sql[i - 2] ?? "");
      let j = i + 1;
      while (j < sql.length) {
        if (escapes && sql[j] === "\\") j += 2;
        else if (sql[j] === c && sql[j + 1] === c) j += 2;
        else if (sql[j] === c) break;
        else j++;
      }
      blank(i + 1, Math.min(j, sql.length));
      i = j + 1;
    } else if (c === "$") {
      const tag = sql.slice(i).match(/^\$([A-Za-z_]\w*)?\$/);
      if (tag && !/\w/.test(sql[i - 1] ?? "")) {
        const end = sql.indexOf(tag[0], i + tag[0].length);
        const stop = end < 0 ? sql.length : end;
        blank(i + tag[0].length, stop);
        i = end < 0 ? sql.length : end + tag[0].length;
      } else i++;
    } else i++;
  }
  return out.join("");
}

/** Strip markdown fences, trailing semicolons and trailing comments. */
export function normalizeSql(sql: string): string {
  let s = sql.trim();
  const fenced = s.match(/^```(?:sql|postgresql|pgsql)?\s*([\s\S]*?)```$/i);
  if (fenced) s = fenced[1].trim();
  const mask = maskSql(s);
  let end = s.length;
  while (end > 0 && /[\s;]/.test(mask[end - 1])) end--;
  return s.slice(0, end).trim();
}

const SQL_QUERY_STARTS = ["select", "with", "values", "table"];
/** Statements that change data or schema (when one is the first word). */
const SQL_WRITE_STARTS = ["insert", "update", "delete", "merge", "truncate", "drop", "alter", "create", "grant", "revoke", "copy", "vacuum", "reindex", "cluster", "comment", "lock", "call", "do", "refresh", "reset", "set"];
/** Words that make a query write: data-modifying CTEs, SELECT ... INTO, FOR UPDATE (mirrors the backend). */
const SQL_WRITE_WORDS = ["insert", "update", "delete", "merge", "truncate", "into"];
const SQL_DENY_FUNCS = ["pg_terminate_backend", "pg_cancel_backend", "pg_reload_conf", "pg_read_file", "pg_read_binary_file", "pg_ls_", "pg_stat_file", "lo_import", "lo_export", "lo_unlink", "dblink", "set_config", "pg_advisory", "pg_promote", "pg_switch_wal", "pg_notify", "pg_sleep"];

/**
 * Client-side check of generated Studio SQL (the backend checks again and
 * runs it READ ONLY - this only gives clearer messages). Returns null when it
 * looks like a single read query; `write` marks an attempt to change data.
 */
export function sqlProblem(sql: string): { write: boolean; message: string } | null {
  const code = maskSql(sql).toLowerCase();
  if (!code.trim()) return { write: false, message: "The model returned an empty query - try rephrasing" };
  if (code.includes(";")) {
    return { write: false, message: "Studio runs a single query, but the model wrote several statements - try rephrasing" };
  }
  const words = code.split(/[^a-z0-9_]+/).filter(Boolean);
  const first = words[0] ?? "";
  if (!SQL_QUERY_STARTS.includes(first)) {
    return SQL_WRITE_STARTS.includes(first)
      ? { write: true, message: `${first.toUpperCase()} changes data - Studio is read-only` }
      : { write: false, message: `Studio only runs SELECT queries, not ${first.toUpperCase()} - try rephrasing` };
  }
  const write = words.find((w) => SQL_WRITE_WORDS.includes(w));
  if (write) {
    return {
      write: true,
      message:
        write === "into"
          ? "SELECT ... INTO creates a table - Studio is read-only"
          : `${write.toUpperCase()} isn't allowed - Studio is read-only`,
    };
  }
  const fn = SQL_DENY_FUNCS.find((f) => code.includes(f));
  if (fn) return { write: false, message: `${fn.replace(/_$/, "")} isn't allowed in a Studio query` };
  return null;
}

const SQL_IDENT = String.raw`"(?:[^"]|"")+"|[A-Za-z_][\w$]*`;
const unquoteIdent = (p: string) => (p.startsWith('"') ? p.slice(1, -1).replace(/""/g, '"') : p.toLowerCase());

/**
 * The table a query mainly reads: the least-nested FROM that names a table
 * (not a subquery, function, CTE or `extract(... FROM col)`), unquoted.
 */
export function firstTable(sql: string): string | undefined {
  const mask = maskSql(sql);
  const ctes = new Set(
    [...sql.matchAll(new RegExp(String.raw`(?:\bwith\b(?:\s+recursive)?|,)\s*(${SQL_IDENT})\s*(?:\([^)]*\))?\s+as\s*(?:not\s+)?(?:materialized\s*)?\(`, "gi"))].map((m) =>
      unquoteIdent(m[1])
    )
  );
  const ident = new RegExp(String.raw`^\s*(?:only\s+)?(${SQL_IDENT})(?:\s*\.\s*(${SQL_IDENT}))?(\s*\()?`, "i");
  let best: { depth: number; name: string } | undefined;
  let depth = 0;
  for (let i = 0; i < mask.length; i++) {
    const c = mask[i];
    if (c === "(") depth++;
    else if (c === ")") depth = Math.max(0, depth - 1);
    else if (/[fF]/.test(c) && /^from\b/i.test(mask.slice(i, i + 5)) && !/[\w$]/.test(mask[i - 1] ?? "")) {
      const hit = sql.slice(i + 4).match(ident);
      if (!hit || hit[3] || !/^\s/.test(sql.slice(i + 4))) continue;
      const name = unquoteIdent(hit[2] ?? hit[1]);
      if (ctes.has(name) || ["select", "lateral"].includes(name)) continue;
      if (!best || depth < best.depth) best = { depth, name };
    }
  }
  return best?.name;
}

/** Normalize a SQL plan: clean SQL, detect writes, reject anything else. */
function normalizeSqlPlan(plan: VizPlan): VizPlan {
  const out: VizPlan = { ...plan, kind: "sql", stages: undefined, filter: undefined, sort: undefined, projection: undefined };
  if (out.chart) {
    const t = String(out.chart.type);
    out.chart = { ...out.chart, type: t === "line" || t === "number" ? t : "bar" };
    if (!out.chart.labelField && out.chart.type !== "number") out.chart = null;
  }
  if (out.writeIntent) return { ...out, sql: undefined, writeIntent: true };
  if (typeof plan.sql !== "string" || !plan.sql.trim()) {
    if (plan.kind === "find" || plan.kind === "aggregate") {
      throw new Error("The model answered with a MongoDB query instead of SQL - try again or switch model");
    }
    throw new Error("The model returned no SQL - try rephrasing");
  }
  const sql = normalizeSql(plan.sql);
  const problem = sqlProblem(sql);
  if (problem?.write) return { ...out, sql, writeIntent: true };
  if (problem) throw new Error(problem.message);
  const collection = typeof plan.collection === "string" && plan.collection.trim() ? plan.collection.trim() : firstTable(sql);
  return { ...out, sql, collection };
}

async function generateSqlPlan(req: VizRequest): Promise<{ plan: VizPlan; usage: TokenUsage }> {
  const multi = !req.collection;
  const tables = req.tables ?? tablesFromFields(req.schema ?? (req.collection ? { [req.collection]: req.fields ?? [] } : {}));
  const context = multi
    ? `Schema: ${req.database}\nTables:\n${sqlSchemaBlock(tables)}${samplesBlock(req.samples, "postgres")}`
    : `Schema: ${req.database}\nTable in scope: ${req.collection}\nTables:\n${sqlSchemaBlock(tables)}${samplesBlock(req.samples, "postgres")}`;
  const user = `${context}${historyBlock(req.history)}\n\nRequest: ${req.prompt}`;
  const { text, usage } = await chat(multi ? SQL_SYSTEM_MULTI : SQL_SYSTEM_SINGLE, user, true);
  return { plan: normalizePlan(parseJson<VizPlan>(text), multi, "postgres"), usage };
}

async function suggestSqlPrompts(
  args: { database: string; collection?: string; fields?: string[]; schema?: DbSchema; tables?: SqlSchema },
  multi: boolean
): Promise<{ prompts: string[]; usage: TokenUsage }> {
  const system = multi
    ? `You suggest analytics questions spanning related tables of a PostgreSQL schema (joins along foreign keys, cross-table rollups).
Respond with ONLY JSON: { "prompts": ["...", "...", "...", "..."] }.
Exactly 4 short prompts (max 11 words), phrased as a non-technical user would type them. Favour questions relating two tables. Base them strictly on the provided tables and columns.`
    : `You suggest analytics questions for a PostgreSQL table.
Respond with ONLY JSON: { "prompts": ["...", "...", "...", "..."] }.
Exactly 4 short prompts (max 9 words), phrased as a non-technical user would type them. At least 2 should produce a chart (grouping, counting, averaging or a time series). Base them strictly on the provided columns.`;
  const tables = args.tables ?? tablesFromFields(args.schema ?? (args.collection ? { [args.collection]: args.fields ?? [] } : {}));
  const user = multi
    ? `Schema: ${args.database}\nTables:\n${sqlSchemaBlock(tables)}`
    : `Schema: ${args.database}\nTable: ${args.collection}\nTables:\n${sqlSchemaBlock(tables)}`;
  return parsePrompts(await chat(system, user, true));
}

/** Four starter questions for a collection or a whole database. */
export async function suggestPrompts(args: {
  engine?: Engine;
  database: string;
  collection?: string;
  fields?: string[];
  schema?: DbSchema;
  /** PostgreSQL: typed tables (whole schema, or the table and its FK targets). */
  tables?: SqlSchema;
}): Promise<{ prompts: string[]; usage: TokenUsage }> {
  const multi = Boolean(args.schema);
  if (args.engine === "postgres") return suggestSqlPrompts(args, multi);
  const system = multi
    ? `You suggest analytics questions spanning related collections of a MongoDB database (joins, cross-collection rollups).
Respond with ONLY JSON: { "prompts": ["...", "...", "...", "..."] }.
Exactly 4 short prompts (max 11 words), phrased as a non-technical user would type them. Favour questions relating two collections. Base them strictly on the provided collections and fields.`
    : `You suggest analytics questions for a MongoDB collection.
Respond with ONLY JSON: { "prompts": ["...", "...", "...", "..."] }.
Exactly 4 short prompts (max 9 words), phrased as a non-technical user would type them. At least 2 should produce a chart (grouping, counting, averaging or a time series). Base them strictly on the provided field names.`;
  const user = multi
    ? `Database: ${args.database}\nCollections and their fields:\n${schemaBlock(args.schema!)}`
    : `Database: ${args.database}\nCollection: ${args.collection}\nFields: ${(args.fields ?? []).slice(0, 80).join(", ") || "(unknown)"}`;
  return parsePrompts(await chat(system, user, true));
}

function parsePrompts({ text, usage }: { text: string; usage: TokenUsage }): { prompts: string[]; usage: TokenUsage } {
  const parsed = parseJson<{ prompts?: unknown }>(text);
  const prompts = Array.isArray(parsed.prompts)
    ? parsed.prompts.filter((p): p is string => typeof p === "string" && p.trim() !== "").slice(0, 4)
    : [];
  if (prompts.length === 0) throw new Error("No suggestions came back - try again");
  return { prompts, usage };
}

/** Plain-language reading of a result set. */
export async function summarizeResults(
  prompt: string,
  docs: unknown[],
  engine: Engine = "mongo"
): Promise<{ summary: string; usage: TokenUsage }> {
  const system = `You summarize ${engine === "postgres" ? "PostgreSQL" : "MongoDB"} query results for a non-technical reader.
Reply with 2-4 short plain-text sentences: the headline finding first, then notable patterns or outliers. No markdown, no code, no JSON.`;
  const sample = JSON.stringify(docs.slice(0, 40)).slice(0, 12000);
  const user = `Original question: ${prompt}\nResults (${docs.length} rows, first 40 shown):\n${sample}`;
  const { text, usage } = await chat(system, user, false);
  return { summary: text.trim(), usage };
}

// ---------------------------------------------------------------------------
// Query assist (shell)
// ---------------------------------------------------------------------------

export interface AssistResult {
  query: string | null;
  notes: string;
  usage: TokenUsage;
}

export interface AssistAction {
  id: string;
  label: string;
  hint: string;
  instruction: string;
}

export const ASSIST_ACTIONS: AssistAction[] = [
  {
    id: "fix",
    label: "Fix errors",
    hint: "repair syntax and logic so it runs",
    instruction: "Fix any syntax or semantic errors in this statement so it runs correctly.",
  },
  {
    id: "optimize",
    label: "Optimize",
    hint: "restructure for speed, suggest indexes",
    instruction:
      "Optimize this statement for performance: reorder or restructure stages, reduce scanned data, and suggest indexes that would help.",
  },
  {
    id: "explain",
    label: "Explain",
    hint: "what it does, step by step",
    instruction: "Explain step by step what this statement does, in plain language. Return query as null.",
  },
  {
    id: "indexes",
    label: "Suggest indexes",
    hint: "exact createIndex statements",
    instruction:
      "Suggest the ideal index(es) for this statement with exact createIndex statements in the notes. Return query as null unless the statement itself should change.",
  },
  {
    id: "safe",
    label: "Make it safe",
    hint: "add limits and projections for big collections",
    instruction: "Make this statement safe to run on a large production collection: add limits and projections where missing.",
  },
];

export const SQL_ASSIST_ACTIONS: AssistAction[] = [
  {
    id: "fix",
    label: "Fix errors",
    hint: "repair syntax and logic so it runs",
    instruction: "Fix any syntax or semantic errors in this SQL so it runs correctly on PostgreSQL.",
  },
  {
    id: "optimize",
    label: "Optimize",
    hint: "rewrite for the planner, suggest indexes",
    instruction:
      "Optimize this SQL for PostgreSQL. Reason about the EXPLAIN plan it would get (sequential scans, join strategy and order, sorts, row estimates) and rewrite it to read less data: sargable predicates (no functions or casts on indexed columns), EXISTS instead of large IN lists, no needless DISTINCT or ORDER BY, filters pushed into joins. Put the CREATE INDEX statements that would help in the notes.",
  },
  {
    id: "explain",
    label: "Explain",
    hint: "what it does, step by step",
    instruction: "Explain step by step what this SQL does, in plain language. Return query as null.",
  },
  {
    id: "indexes",
    label: "Suggest indexes",
    hint: "exact CREATE INDEX statements",
    instruction:
      "Suggest the ideal index(es) for this SQL with exact CREATE INDEX CONCURRENTLY statements in the notes (right column order; partial, expression or INCLUDE indexes where they fit). Return query as null unless the SQL itself should change.",
  },
  {
    id: "safe",
    label: "Make it safe",
    hint: "LIMIT, explicit columns, guarded writes",
    instruction:
      "Make this SQL safe to run on a large production table: add a LIMIT to row-returning SELECTs, replace SELECT * with explicit columns, and make sure every UPDATE / DELETE has a selective WHERE clause. Mention in the notes anything that would still lock or scan a big table.",
  },
];

export const assistActions = (engine: Engine) => (engine === "postgres" ? SQL_ASSIST_ACTIONS : ASSIST_ACTIONS);

const ASSIST_SYSTEM_SQL = `You are a PostgreSQL expert inside a database GUI.
You get SQL from the GUI's SQL shell (one or more statements run top to bottom, with the current schema on the search_path), optionally a task written by the user, the last error and the current table's columns with their types.
Respond with ONLY a JSON object:
{
  "query": "the improved or fixed SQL, or null if it should not change",
  "notes": "concise plain-text explanation: what changed and why, index suggestions, pitfalls. Short lines, no markdown headings."
}
The SQL must stay runnable PostgreSQL; separate multiple statements with semicolons and keep their order. Never turn a read into a write. Never invent tables or columns that are not plausible from the context.`;

const ASSIST_SYSTEM = `You are a MongoDB expert inside a database GUI.
You get a mongosh statement (db.collection.find(...), .aggregate([...]), ...), optionally a task written by the user, the last error and sampled schema fields.
Respond with ONLY a JSON object:
{
  "query": "the improved or fixed mongosh statement, or null if it should not change",
  "notes": "concise plain-text explanation: what changed and why, index suggestions, pitfalls. Short lines, no markdown headings."
}
The statement must stay a single runnable mongosh statement. Never invent fields that are not plausible from the context.`;

export async function assistQuery(args: {
  /** Engine of the workspace; "postgres" switches the prompts to SQL. */
  engine?: Engine;
  query: string;
  instruction: string;
  database: string;
  collection?: string;
  fields?: string[];
  error?: string | null;
}): Promise<AssistResult> {
  const pg = (args.engine ?? writeGuard.engine()) === "postgres";
  const user = [
    `${pg ? "Schema" : "Database"}: ${args.database}`,
    args.collection ? `${pg ? "Table" : "Collection"}: ${args.collection}` : null,
    args.fields?.length ? `${pg ? "Columns" : "Known fields"}: ${args.fields.slice(0, 80).join(", ")}` : null,
    args.error ? `Last error: ${args.error}` : null,
    `Task: ${args.instruction}`,
    `${pg ? "SQL" : "Statement"}:\n${args.query}`,
  ]
    .filter(Boolean)
    .join("\n");
  const { text, usage } = await chat(pg ? ASSIST_SYSTEM_SQL : ASSIST_SYSTEM, user, true);
  const parsed = parseJson<{ query?: unknown; notes?: unknown }>(text);
  const query = typeof parsed.query === "string" && parsed.query.trim() ? parsed.query.trim() : null;
  return { query, notes: typeof parsed.notes === "string" ? parsed.notes.trim() : "", usage };
}

// ---------------------------------------------------------------------------
// Explain plans
// ---------------------------------------------------------------------------

const EXPLAIN_SYSTEM = `You are a MongoDB performance expert reading an explain plan inside a database GUI.
Reply in plain text (no markdown, no JSON), 3-6 short lines:
Line 1: a one-sentence verdict - is this query healthy, and why.
Then: what the plan did (index vs scan, docs examined vs returned, sort behaviour).
Then: the single most impactful fix, with an exact createIndex statement if an index would help.
Be concrete and terse; never invent fields that are not in the plan.`;

const EXPLAIN_SYSTEM_SQL = `You are a PostgreSQL performance expert reading an EXPLAIN (FORMAT JSON) plan inside a database GUI.
Reply in plain text (no markdown, no JSON), 3-6 short lines:
Line 1: a one-sentence verdict - is this query healthy, and why.
Then: what the plan did - Seq Scan vs Index / Index Only / Bitmap scans, rows removed by filters, join strategy (a Nested Loop over many outer rows is a red flag), and estimated vs actual rows (a miss of 10x or more means stale statistics: suggest ANALYZE or extended statistics).
Flag spills: a Sort using external merge or a Hash with more than one batch means work_mem is too small for it.
Then: the single most impactful fix, with an exact CREATE INDEX statement if an index would help.
Be concrete and terse; cite the numbers from the plan; never invent columns that are not in the plan.`;

export async function interpretExplain(args: {
  /** Engine of the workspace; "postgres" reads an EXPLAIN (FORMAT JSON) plan. */
  engine?: Engine;
  database: string;
  collection: string;
  summary: unknown;
  raw: unknown;
}): Promise<{ notes: string; usage: TokenUsage }> {
  const pg = (args.engine ?? writeGuard.engine()) === "postgres";
  const user = [
    pg ? `Table: ${args.database}.${args.collection}` : `Namespace: ${args.database}.${args.collection}`,
    `Summary: ${JSON.stringify(args.summary)}`,
    `Raw plan (may be truncated):\n${JSON.stringify(args.raw).slice(0, 14000)}`,
  ].join("\n");
  const { text, usage } = await chat(pg ? EXPLAIN_SYSTEM_SQL : EXPLAIN_SYSTEM, user, false);
  return { notes: text.trim(), usage };
}

/** "1.2k tokens · $0.0031" */
export function formatUsage(u: TokenUsage): string {
  const tokens = u.total >= 1000 ? `${(u.total / 1000).toFixed(1)}k` : String(u.total);
  const cost = u.cost > 0 ? ` · $${u.cost < 0.01 ? u.cost.toFixed(4) : u.cost.toFixed(2)}` : "";
  return `${tokens} tokens${cost}`;
}
