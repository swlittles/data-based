import type { Doc, Engine, TableMeta } from "@/lib/api";
import { idLabel, leafText, toShellText } from "@/lib/bson";

/**
 * Engine differences the UI cares about, in one place.
 *
 * The explorer speaks MongoDB's vocabulary internally (database, collection,
 * document, `_id`). For PostgreSQL a "database" is a schema, a "collection" a
 * table, a "document" a row, and a row's identity is its primary key as an
 * object - `{ id: 7 }` or `{ order_id: 1, line: 2 }`.
 */

/** How rows are addressed: MongoDB's `_id`, or a Postgres primary key. */
export interface RowIdentity {
  engine: Engine;
  /** Primary key columns (Postgres); empty when the table has none. */
  key: string[];
  /** Views / materialized views can't be edited. */
  editable: boolean;
}

export const MONGO_IDENTITY: RowIdentity = { engine: "mongo", key: ["_id"], editable: true };

export function identityFor(engine: Engine, meta: TableMeta | null | undefined): RowIdentity {
  if (engine === "mongo") return MONGO_IDENTITY;
  return {
    engine,
    key: meta?.primaryKey ?? [],
    editable: meta ? ["table", "partitioned", "foreign"].includes(meta.kind) : true,
  };
}

/** The value that identifies a row, or undefined when it can't be addressed. */
export function rowId(doc: Doc, ident: RowIdentity): unknown {
  if (ident.engine === "mongo") return "_id" in doc ? doc._id : undefined;
  if (ident.key.length === 0 || !ident.key.every((k) => k in doc)) return undefined;
  const out: Doc = {};
  for (const k of ident.key) out[k] = doc[k];
  return out;
}

/** Stable string key for selection / React keys, or null. */
export function rowKey(doc: Doc, ident: RowIdentity): string | null {
  const id = rowId(doc, ident);
  return id === undefined ? null : JSON.stringify(id);
}

/** Can this row be edited / deleted individually? */
export function canAddress(doc: Doc, ident: RowIdentity): boolean {
  return ident.editable && rowId(doc, ident) !== undefined;
}

/** Short human label: `_id 65f…` / `id 7` / `order_id 1 · line 2`. */
export function rowLabel(doc: Doc, ident: RowIdentity): string {
  if (ident.engine === "mongo") return `_id ${idLabel(doc)}`;
  if (ident.key.length === 0) return "row";
  return ident.key.map((k) => `${k} ${leafText(doc[k])}`).join(" · ");
}

/** Just the value part of the label (drawer header). */
export function rowIdText(doc: Doc, ident: RowIdentity): string {
  if (ident.engine === "mongo") return idLabel(doc);
  if (ident.key.length === 0) return "no primary key";
  return ident.key.map((k) => (ident.key.length > 1 ? `${k}=${leafText(doc[k])}` : leafText(doc[k]))).join(", ");
}

/** A SQL literal for a JSON value. Strings are quoted; objects / arrays go
 *  through their JSON text (Postgres casts from the column type). */
export function sqlLiteral(v: unknown): string {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : `'${v}'`;
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  const text = typeof v === "string" ? v : JSON.stringify(v);
  return `'${text.replace(/'/g, "''")}'`;
}

/** Quote an identifier when it isn't a plain lower-case name. */
export function sqlIdent(name: string): string {
  return /^[a-z_][a-z0-9_]*$/.test(name) ? name : `"${name.replace(/"/g, '""')}"`;
}

/** Filter text matching exactly these row ids (for bulk delete / backups). */
export function idsFilter(ids: unknown[], ident: RowIdentity): string {
  if (ident.engine === "mongo") return toShellText({ _id: { $in: ids } });
  const cols = ident.key.map(sqlIdent);
  if (cols.length === 1) {
    const vals = ids.map((id) => sqlLiteral((id as Doc)[ident.key[0]]));
    return `${cols[0]} IN (${vals.join(", ")})`;
  }
  const tuples = ids.map((id) => `(${ident.key.map((k) => sqlLiteral((id as Doc)[k])).join(", ")})`);
  return `(${cols.join(", ")}) IN (${tuples.join(", ")})`;
}

/** Editable text for a document: shell syntax for MongoDB, JSON for rows. */
export function docText(doc: unknown, engine: Engine): string {
  return engine === "postgres" ? JSON.stringify(doc, null, 2) : toShellText(doc);
}

/** Words for the UI. */
export function terms(engine: Engine) {
  return engine === "postgres"
    ? {
        db: "schema",
        dbs: "schemas",
        Db: "Schema",
        coll: "table",
        colls: "tables",
        Coll: "Table",
        doc: "row",
        docs: "rows",
        Doc: "Row",
        Docs: "Rows",
        field: "column",
        fields: "columns",
        Field: "Column",
      }
    : {
        db: "database",
        dbs: "databases",
        Db: "Database",
        coll: "collection",
        colls: "collections",
        Coll: "Collection",
        doc: "document",
        docs: "documents",
        Doc: "Document",
        Docs: "Documents",
        field: "field",
        fields: "fields",
        Field: "Field",
      };
}

/** Starter statement for a new shell tab. */
export function shellStarter(engine: Engine, collection: string): string {
  if (engine === "postgres") return `SELECT *\nFROM ${sqlIdent(collection)}\nLIMIT 100;\n`;
  return `db.${/^[A-Za-z_][\w]*$/.test(collection) ? collection : `getCollection("${collection}")`}.find({})\n`;
}

/** The find query written out as a statement for the shell. */
export function findAsShell(
  engine: Engine,
  collection: string,
  q: { filter: string; sort: string; projection: string; limit: number }
): string {
  if (engine === "postgres") {
    const parts = [`SELECT ${q.projection.trim() || "*"}`, `FROM ${sqlIdent(collection)}`];
    if (q.filter.trim()) parts.push(`WHERE ${q.filter.trim()}`);
    if (q.sort.trim()) parts.push(`ORDER BY ${q.sort.trim()}`);
    parts.push(`LIMIT ${q.limit};`);
    return parts.join("\n");
  }
  const coll = /^[A-Za-z_]\w*$/.test(collection) ? collection : `getCollection("${collection}")`;
  return `db.${coll}.find(${q.filter.trim() || "{}"})${q.sort.trim() ? `.sort(${q.sort})` : ""}${
    q.projection.trim() ? `.project(${q.projection})` : ""
  }.limit(${q.limit})`;
}

/** Insert template for a Postgres table: every column a user must provide,
 *  set to null (identity, generated and defaulted columns are left out). */
export function insertTemplate(meta: TableMeta | null | undefined): Doc {
  const out: Doc = {};
  for (const c of meta?.columns ?? []) {
    if (c.generated || c.identity || c.default) continue;
    out[c.name] = null;
  }
  return out;
}

/** Drop columns the database fills in itself before duplicating a row. */
export function stripGenerated(doc: Doc, meta: TableMeta | null | undefined): Doc {
  if (!meta) return doc;
  const out: Doc = {};
  for (const [k, v] of Object.entries(doc)) {
    const c = meta.columns.find((x) => x.name === k);
    if (c && (c.generated || c.identity || (meta.primaryKey.includes(k) && c.default))) continue;
    out[k] = v;
  }
  return out;
}

/** Shorter spellings of verbose SQL type names ("timestamp with time zone" -> "timestamptz"). */
export function shortType(t: string): string {
  return t
    .replace(/^timestamp with time zone$/, "timestamptz")
    .replace(/^timestamp without time zone$/, "timestamp")
    .replace(/^time with time zone$/, "timetz")
    .replace(/^time without time zone$/, "time")
    .replace(/^character varying/, "varchar")
    .replace(/^character\b/, "char")
    .replace(/^double precision$/, "float8");
}
