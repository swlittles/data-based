import { useEffect, useId, useMemo, useState } from "react";
import { ListFilter, Plus, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { api, type ColumnMeta } from "@/lib/api";
import { sqlIdent, sqlLiteral } from "@/lib/engine";
import { useEngine } from "@/stores/connections";
import { cn } from "@/lib/utils";

type Op =
  | "eq"
  | "ne"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "between"
  | "contains"
  | "startsWith"
  | "endsWith"
  | "regex"
  | "in"
  | "nin"
  | "type"
  | "exists"
  | "notexists"
  // PostgreSQL only
  | "like"
  | "isnull"
  | "notnull";

const OPS: { value: Op; label: string }[] = [
  { value: "eq", label: "= equals" },
  { value: "ne", label: "≠ not equals" },
  { value: "gt", label: "> greater" },
  { value: "gte", label: "≥ greater or eq" },
  { value: "lt", label: "< less" },
  { value: "lte", label: "≤ less or eq" },
  { value: "between", label: "between" },
  { value: "contains", label: "contains" },
  { value: "startsWith", label: "starts with" },
  { value: "endsWith", label: "ends with" },
  { value: "regex", label: "regex" },
  { value: "in", label: "in (a, b)" },
  { value: "nin", label: "not in (a, b)" },
  { value: "type", label: "is type" },
  { value: "exists", label: "exists" },
  { value: "notexists", label: "not exists" },
];

/** PostgreSQL: the operators a WHERE condition can use. */
const PG_OPS: { value: Op; label: string }[] = [
  { value: "eq", label: "= equals" },
  { value: "ne", label: "<> not equals" },
  { value: "gt", label: "> greater" },
  { value: "gte", label: ">= greater or eq" },
  { value: "lt", label: "< less" },
  { value: "lte", label: "<= less or eq" },
  { value: "between", label: "BETWEEN" },
  { value: "contains", label: "contains (ILIKE)" },
  { value: "startsWith", label: "starts with (ILIKE)" },
  { value: "endsWith", label: "ends with (ILIKE)" },
  { value: "like", label: "LIKE pattern" },
  { value: "in", label: "IN (a, b)" },
  { value: "nin", label: "NOT IN (a, b)" },
  { value: "isnull", label: "IS NULL" },
  { value: "notnull", label: "IS NOT NULL" },
];

const VALUELESS: Op[] = ["exists", "notexists", "isnull", "notnull"];
const BSON_TYPES = [
  "string",
  "int",
  "long",
  "double",
  "decimal",
  "bool",
  "date",
  "objectId",
  "array",
  "object",
  "null",
  "binData",
  "timestamp",
];

let rid = 0;
interface Row {
  id: number;
  field: string;
  op: Op;
  value: string;
  value2: string; // second operand for "between"
}
const newRow = (): Row => ({ id: rid++, field: "", op: "eq", value: "", value2: "" });

// Render a scalar as mongosh-flavored text, guessing the JSON type.
function valueToken(field: string, raw: string): string {
  const v = raw.trim();
  if (v === "") return '""';
  if (/^-?\d+(\.\d+)?$/.test(v)) return v;
  if (v === "true" || v === "false" || v === "null") return v;
  // 24-hex on _id / *Id fields → ObjectId
  if (/^[a-f0-9]{24}$/i.test(v) && (field === "_id" || /(^|\.)_?id$/i.test(field) || /Id$/.test(field))) {
    return `ObjectId("${v}")`;
  }
  // ISO-ish date → ISODate
  if (/^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2})?/.test(v)) return `ISODate("${v}")`;
  return JSON.stringify(v);
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function clause(row: Row): string | null {
  const field = row.field.trim();
  if (!field) return null;
  const key = JSON.stringify(field);
  const val = () => valueToken(field, row.value);
  switch (row.op) {
    case "eq":
      return `${key}: ${val()}`;
    case "ne":
      return `${key}: { $ne: ${val()} }`;
    case "gt":
    case "gte":
    case "lt":
    case "lte":
      return `${key}: { $${row.op}: ${val()} }`;
    case "between":
      return `${key}: { $gte: ${valueToken(field, row.value)}, $lte: ${valueToken(field, row.value2)} }`;
    case "contains":
      return `${key}: { $regex: ${JSON.stringify(escapeRegex(row.value))}, $options: "i" }`;
    case "startsWith":
      return `${key}: { $regex: ${JSON.stringify("^" + escapeRegex(row.value))}, $options: "i" }`;
    case "endsWith":
      return `${key}: { $regex: ${JSON.stringify(escapeRegex(row.value) + "$")}, $options: "i" }`;
    case "regex":
      return `${key}: { $regex: ${JSON.stringify(row.value)}, $options: "i" }`;
    case "in":
    case "nin": {
      const items = row.value
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .map((s) => valueToken(field, s));
      return `${key}: { $${row.op}: [${items.join(", ")}] }`;
    }
    case "type":
      return `${key}: { $type: ${JSON.stringify(row.value || "string")} }`;
    case "exists":
      return `${key}: { $exists: true }`;
    case "notexists":
      return `${key}: { $exists: false }`;
    default:
      return null;
  }
}

// ---------------------------------------------------------------- PostgreSQL

const NUMERIC_TYPE = /^(smallint|integer|bigint|int\d?|numeric|decimal|real|double precision|float\d?|money|smallserial|serial|bigserial)\b/;
const TEXT_TYPE = /^(text|character|char|varchar|citext|name|bpchar)\b/;
const DATE_TYPE = /^date$/;

type ColKind = "number" | "bool" | "date" | "text" | "other";

function colKind(dataType: string | undefined): ColKind {
  const t = (dataType ?? "").toLowerCase();
  if (NUMERIC_TYPE.test(t)) return "number";
  if (t === "boolean" || t === "bool") return "bool";
  if (DATE_TYPE.test(t)) return "date";
  if (TEXT_TYPE.test(t)) return "text";
  return "other";
}

/** A SQL literal for one typed-in value: bare numbers / booleans for those
 *  column types, a quoted string otherwise (Postgres casts it to the column). */
function sqlValue(kind: ColKind, raw: string): string {
  const v = raw.trim();
  if (v.toLowerCase() === "null") return "NULL";
  if (kind === "number" && /^-?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(v)) return v;
  if (kind === "bool" && /^(true|false)$/i.test(v)) return v.toUpperCase();
  return sqlLiteral(v);
}

/** Escape LIKE wildcards so "contains 50%" means the literal text. */
function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, "\\$&");
}

function pgClause(row: Row, columns: ColumnMeta[]): string | null {
  const field = row.field.trim();
  if (!field) return null;
  const col = columns.find((c) => c.name === field);
  // A known column is quoted as needed; anything else (meta->>'plan',
  // lower(email)) is taken as a SQL expression.
  const expr = col || /^[a-z_][a-z0-9_]*$/.test(field) ? sqlIdent(field) : field;
  const kind = colKind(col?.dataType);
  const val = (raw: string) => sqlValue(kind, raw);
  // Pattern matches need text; cast other column types.
  const textExpr = kind === "text" ? expr : `${expr}::text`;
  const ops: Partial<Record<Op, string>> = { eq: "=", ne: "<>", gt: ">", gte: ">=", lt: "<", lte: "<=" };
  switch (row.op) {
    case "eq":
    case "ne":
    case "gt":
    case "gte":
    case "lt":
    case "lte":
      return `${expr} ${ops[row.op]} ${val(row.value)}`;
    case "between":
      return `${expr} BETWEEN ${val(row.value)} AND ${val(row.value2)}`;
    case "contains":
      return `${textExpr} ILIKE ${sqlLiteral(`%${escapeLike(row.value)}%`)}`;
    case "startsWith":
      return `${textExpr} ILIKE ${sqlLiteral(`${escapeLike(row.value)}%`)}`;
    case "endsWith":
      return `${textExpr} ILIKE ${sqlLiteral(`%${escapeLike(row.value)}`)}`;
    case "like":
      return `${textExpr} LIKE ${sqlLiteral(row.value)}`;
    case "in":
    case "nin": {
      const items = row.value
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .map(val);
      if (items.length === 0) return row.op === "in" ? "FALSE" : null;
      return `${expr} ${row.op === "in" ? "IN" : "NOT IN"} (${items.join(", ")})`;
    }
    case "isnull":
      return `${expr} IS NULL`;
    case "notnull":
      return `${expr} IS NOT NULL`;
    default:
      return null;
  }
}

/** A SQL WHERE condition (blank = every row). */
export function buildWhere(rows: Row[], combinator: "and" | "or", columns: ColumnMeta[]): string {
  const clauses = rows.map((r) => pgClause(r, columns)).filter((c): c is string => c !== null);
  return clauses.join(combinator === "or" ? " OR " : " AND ");
}

export function buildFilter(rows: Row[], combinator: "and" | "or"): string {
  const clauses = rows.map(clause).filter((c): c is string => c !== null);
  if (clauses.length === 0) return "{}";
  if (combinator === "or") {
    return `{ $or: [${clauses.map((c) => `{ ${c} }`).join(", ")}] }`;
  }
  // AND: merge into one object, unless a field repeats - then use $and.
  const fields = rows.filter((r) => r.field.trim()).map((r) => r.field.trim());
  const hasDup = new Set(fields).size !== fields.length;
  if (hasDup) return `{ $and: [${clauses.map((c) => `{ ${c} }`).join(", ")}] }`;
  return `{ ${clauses.join(", ")} }`;
}

export function QueryBuilder({
  database,
  collection,
  onApply,
}: {
  database: string;
  collection: string;
  onApply: (filter: string) => void;
}) {
  const [rows, setRows] = useState<Row[]>([newRow()]);
  const [combinator, setCombinator] = useState<"and" | "or">("and");
  const [fields, setFields] = useState<string[]>([]);
  const [columns, setColumns] = useState<ColumnMeta[]>([]);
  const listId = useId();
  const pg = useEngine() === "postgres";

  useEffect(() => {
    let alive = true;
    if (pg) {
      // Declared columns (with types) beat a sample.
      api
        .tableMeta(database, collection)
        .then((m) => {
          if (!alive) return;
          setColumns(m.columns);
          setFields(m.columns.map((c) => c.name));
        })
        .catch(() => {
          api
            .collectionFields(database, collection, 1000)
            .then((f) => alive && setFields(f))
            .catch(() => {});
        });
    } else {
      api
        .collectionFields(database, collection, 1000)
        .then((f) => alive && setFields(f))
        .catch(() => {});
    }
    return () => {
      alive = false;
    };
  }, [database, collection, pg]);

  const update = (id: number, patch: Partial<Row>) =>
    setRows((rs) => rs.map((r) => (r.id === id ? { ...r, ...patch } : r)));

  const preview = useMemo(
    () => (pg ? buildWhere(rows, combinator, columns) : buildFilter(rows, combinator)),
    [rows, combinator, pg, columns]
  );
  const ops = pg ? PG_OPS : OPS;
  const colOf = (field: string) => columns.find((c) => c.name === field.trim());
  // Numeric / date columns get matching inputs (IN lists stay free text).
  const inputType = (row: Row) => {
    if (!pg || row.op === "in" || row.op === "nin") return undefined;
    if (["contains", "startsWith", "endsWith", "like"].includes(row.op)) return undefined;
    const kind = colKind(colOf(row.field)?.dataType);
    return kind === "number" ? "number" : kind === "date" ? "date" : undefined;
  };

  return (
    <div className="w-[480px] space-y-2.5">
      <datalist id={listId}>
        {fields.map((f) => (
          <option key={f} value={f} />
        ))}
      </datalist>

      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5 text-[13px] font-medium">
          <ListFilter className="h-3.5 w-3.5 text-primary" />
          Query builder
        </div>
        <div className="seg">
          {(["and", "or"] as const).map((c) => (
            <button key={c} onClick={() => setCombinator(c)} className={cn(combinator === c && "on")}>
              {c === "and" ? "Match ALL" : "Match ANY"}
            </button>
          ))}
        </div>
      </div>

      <div className="space-y-1.5">
        {rows.map((row, i) => (
          <div key={row.id} className="space-y-1">
            {i > 0 && (
              <p className="lbl pl-1">
                {combinator}
              </p>
            )}
            <div className="flex items-center gap-1.5">
              <Input
                value={row.field}
                onChange={(e) => update(row.id, { field: e.target.value })}
                placeholder={pg ? "column" : "field"}
                list={listId}
                autoComplete="off"
                className="h-8 flex-1 font-mono text-xs"
                spellCheck={false}
              />
              <Select value={row.op} onValueChange={(v) => update(row.id, { op: v as Op })}>
                <SelectTrigger className="h-8 w-[170px] shrink-0 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ops.map((o) => (
                    <SelectItem key={o.value} value={o.value} className="text-xs">
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <button
                className="ico dgr shrink-0"
                disabled={rows.length === 1}
                onClick={() => setRows((rs) => rs.filter((r) => r.id !== row.id))}
                aria-label="Remove condition"
              >
                <X />
              </button>
            </div>
            {/* value row */}
            {!VALUELESS.includes(row.op) &&
              (row.op === "type" ? (
                <Select value={row.value || "string"} onValueChange={(v) => update(row.id, { value: v })}>
                  <SelectTrigger className="h-8 w-full text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {BSON_TYPES.map((t) => (
                      <SelectItem key={t} value={t} className="text-xs">
                        {t}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : row.op === "between" ? (
                <div className="flex items-center gap-1.5">
                  <Input
                    value={row.value}
                    onChange={(e) => update(row.id, { value: e.target.value })}
                    type={inputType(row)}
                    placeholder="min"
                    className="h-8 flex-1 font-mono text-xs"
                    spellCheck={false}
                  />
                  <span className="text-[11px] text-text-3">and</span>
                  <Input
                    value={row.value2}
                    onChange={(e) => update(row.id, { value2: e.target.value })}
                    type={inputType(row)}
                    placeholder="max"
                    className="h-8 flex-1 font-mono text-xs"
                    spellCheck={false}
                  />
                </div>
              ) : (
                <Input
                  value={row.value}
                  onChange={(e) => update(row.id, { value: e.target.value })}
                  type={inputType(row)}
                  placeholder={
                    row.op === "in" || row.op === "nin"
                      ? "comma, separated, values"
                      : row.op === "like"
                        ? "pattern: % any, _ one character"
                        : pg && colOf(row.field)
                          ? `value (${colOf(row.field)!.dataType})`
                          : "value"
                  }
                  className="h-8 w-full font-mono text-xs"
                  spellCheck={false}
                />
              ))}
          </div>
        ))}
      </div>

      <button className="btn qt sm" onClick={() => setRows((rs) => [...rs, newRow()])}>
        <Plus />
        Add condition
      </button>

      <div className="notice mono">
        <code className="block break-all">{pg ? (preview ? `WHERE ${preview}` : "(no WHERE - every row)") : preview}</code>
      </div>

      <div className="flex items-center justify-between">
        <span className="font-mono text-[10px] text-text-3">
          {pg
            ? fields.length > 0
              ? `${fields.length} column${fields.length === 1 ? "" : "s"}`
              : "loading columns..."
            : fields.length > 0
              ? `${fields.length} fields from latest 1000 docs`
              : "loading fields..."}
        </span>
        <div className="flex gap-2">
          <button className="btn sm" onClick={() => setRows([newRow()])}>
            Clear
          </button>
          <button className="btn pri sm" onClick={() => onApply(preview)}>
            Apply filter
          </button>
        </div>
      </div>
    </div>
  );
}
