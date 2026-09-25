import { api } from "@/lib/api";
import { AI_NOT_READY, useAi } from "@/stores/ai";

/**
 * Prompt library for every AI feature: Studio (question -> read-only query ->
 * chart), query assist in the shell, and explain-plan reading. All calls go
 * through the backend's OpenRouter proxy with the model + mode from settings.
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
  kind: "find" | "aggregate";
  /** Collection the query runs on (required in whole-database mode). */
  collection?: string;
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

export interface VizRequest {
  prompt: string;
  database: string;
  /** Single-collection mode. */
  collection?: string;
  fields?: string[];
  /** Whole-database mode: chosen collections and one sample document each. */
  schema?: DbSchema;
  samples?: Record<string, unknown>;
  history?: VizHistoryItem[];
}

/** Aggregation stages that write. Never allowed from Studio (the backend
 *  rejects them too). */
export const WRITE_STAGES = ["$out", "$merge"];

const RESULT_LIMIT = 500;

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

function samplesBlock(samples?: Record<string, unknown>): string {
  if (!samples || Object.keys(samples).length === 0) return "";
  const blocks = Object.entries(samples)
    .map(([name, doc]) => `${name}:\n${JSON.stringify(doc).slice(0, 1200)}`)
    .join("\n\n");
  return `\n\nOne sample document per collection (study types and references):\n${blocks}`;
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
  prompt: string;
  database: string;
  schema: DbSchema;
}): Promise<{ collections: string[]; usage: TokenUsage }> {
  const user = `Database: ${args.database}\nQuestion: ${args.prompt}\n\nCollections and their fields:\n${schemaBlock(args.schema)}`;
  const { text, usage } = await chat(SELECT_SYSTEM, user, true);
  const parsed = parseJson<{ collections?: unknown }>(text);
  const valid = new Set(Object.keys(args.schema));
  const picked = Array.isArray(parsed.collections)
    ? parsed.collections.filter((c): c is string => typeof c === "string" && valid.has(c))
    : [];
  return { collections: picked.slice(0, 6), usage };
}

/** Normalize a model's plan: string bodies, legacy chart types, write detection. */
export function normalizePlan(plan: VizPlan, multi: boolean): VizPlan {
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

/** Four starter questions for a collection or a whole database. */
export async function suggestPrompts(args: {
  database: string;
  collection?: string;
  fields?: string[];
  schema?: DbSchema;
}): Promise<{ prompts: string[]; usage: TokenUsage }> {
  const multi = Boolean(args.schema);
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
  const { text, usage } = await chat(system, user, true);
  const parsed = parseJson<{ prompts?: unknown }>(text);
  const prompts = Array.isArray(parsed.prompts)
    ? parsed.prompts.filter((p): p is string => typeof p === "string" && p.trim() !== "").slice(0, 4)
    : [];
  if (prompts.length === 0) throw new Error("No suggestions came back - try again");
  return { prompts, usage };
}

/** Plain-language reading of a result set. */
export async function summarizeResults(prompt: string, docs: unknown[]): Promise<{ summary: string; usage: TokenUsage }> {
  const system = `You summarize MongoDB query results for a non-technical reader.
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

export const ASSIST_ACTIONS: { id: string; label: string; hint: string; instruction: string }[] = [
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

const ASSIST_SYSTEM = `You are a MongoDB expert inside a database GUI.
You get a mongosh statement (db.collection.find(...), .aggregate([...]), ...), optionally a task written by the user, the last error and sampled schema fields.
Respond with ONLY a JSON object:
{
  "query": "the improved or fixed mongosh statement, or null if it should not change",
  "notes": "concise plain-text explanation: what changed and why, index suggestions, pitfalls. Short lines, no markdown headings."
}
The statement must stay a single runnable mongosh statement. Never invent fields that are not plausible from the context.`;

export async function assistQuery(args: {
  query: string;
  instruction: string;
  database: string;
  collection?: string;
  fields?: string[];
  error?: string | null;
}): Promise<AssistResult> {
  const user = [
    `Database: ${args.database}`,
    args.collection ? `Collection: ${args.collection}` : null,
    args.fields?.length ? `Known fields: ${args.fields.slice(0, 80).join(", ")}` : null,
    args.error ? `Last error: ${args.error}` : null,
    `Task: ${args.instruction}`,
    `Statement:\n${args.query}`,
  ]
    .filter(Boolean)
    .join("\n");
  const { text, usage } = await chat(ASSIST_SYSTEM, user, true);
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

export async function interpretExplain(args: {
  database: string;
  collection: string;
  summary: unknown;
  raw: unknown;
}): Promise<{ notes: string; usage: TokenUsage }> {
  const user = [
    `Namespace: ${args.database}.${args.collection}`,
    `Summary: ${JSON.stringify(args.summary)}`,
    `Raw plan (may be truncated):\n${JSON.stringify(args.raw).slice(0, 14000)}`,
  ].join("\n");
  const { text, usage } = await chat(EXPLAIN_SYSTEM, user, false);
  return { notes: text.trim(), usage };
}

/** "1.2k tokens · $0.0031" */
export function formatUsage(u: TokenUsage): string {
  const tokens = u.total >= 1000 ? `${(u.total / 1000).toFixed(1)}k` : String(u.total);
  const cost = u.cost > 0 ? ` · $${u.cost < 0.01 ? u.cost.toFixed(4) : u.cost.toFixed(2)}` : "";
  return `${tokens} tokens${cost}`;
}
