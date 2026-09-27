import { describe, expect, it } from "vitest";
import {
  assistActions,
  ASSIST_ACTIONS,
  extractJson,
  firstTable,
  formatUsage,
  maskSql,
  normalizeChart,
  normalizePlan,
  normalizeSql,
  planToShell,
  shortType,
  SQL_ASSIST_ACTIONS,
  sqlProblem,
  sqlSchemaBlock,
  type VizPlan,
} from "./ai";

describe("extractJson", () => {
  it("unwraps fenced and chatty replies", () => {
    expect(extractJson('```json\n{"a":1}\n```')).toBe('{"a":1}');
    expect(extractJson('Sure! {"a":{"b":2}} hope that helps')).toBe('{"a":{"b":2}}');
    expect(extractJson('{"a":1}')).toBe('{"a":1}');
  });
});

describe("normalizePlan", () => {
  const base: VizPlan = { kind: "aggregate", explanation: "x", stages: [{ op: "$match", body: "{}" }] };

  it("stringifies non-string stage bodies", () => {
    const p = normalizePlan({ ...base, stages: [{ op: "$limit", body: 5 as unknown as string }] }, false);
    expect(p.stages).toEqual([{ op: "$limit", body: "5" }]);
  });

  it("flags write stages as write intent", () => {
    const p = normalizePlan({ ...base, stages: [{ op: " $OUT ", body: '"copy"' }] }, false);
    expect(p.writeIntent).toBe(true);
  });

  it("maps legacy pie charts to donuts and keeps line/number", () => {
    const chart = { labelField: "_id", valueField: "n" };
    expect(normalizePlan({ ...base, chart: { ...chart, type: "pie" as never } }, false).chart?.type).toBe("donut");
    expect(normalizePlan({ ...base, chart: { ...chart, type: "line" } }, false).chart?.type).toBe("line");
  });

  it("requires a collection in whole-database mode", () => {
    expect(() => normalizePlan(base, true)).toThrow(/collection/);
    expect(normalizePlan({ ...base, collection: "orders" }, true).collection).toBe("orders");
  });

  it("rejects unusable plans", () => {
    expect(() => normalizePlan({ ...base, kind: "delete" as never }, false)).toThrow();
    expect(() => normalizePlan({ ...base, stages: [] }, false)).toThrow(/empty/);
  });
});

describe("planToShell", () => {
  it("renders find with sort and capped limit", () => {
    const p: VizPlan = { kind: "find", explanation: "", filter: "{ a: 1 }", sort: "{ b: -1 }", limit: 9999 };
    expect(planToShell(p, "orders")).toBe("db.orders.find({ a: 1 }).sort({ b: -1 }).limit(500)");
  });

  it("quotes awkward collection names", () => {
    const p: VizPlan = { kind: "aggregate", explanation: "", stages: [{ op: "$count", body: '"n"' }] };
    expect(planToShell(p, "my-coll")).toBe('db.getCollection("my-coll").aggregate([\n  { $count: "n" }\n])');
  });
});

describe("maskSql / normalizeSql", () => {
  it("blanks comments and literal bodies but keeps length and delimiters", () => {
    const sql = `SELECT 'a;b', "x;y", $f$ ; $f$, E'it\\'s;' -- c;\nFROM t /* ; */`;
    const m = maskSql(sql);
    expect(m.length).toBe(sql.length);
    expect(m).not.toContain(";");
    expect(m).toContain("FROM t");
    expect(maskSql("select 'it''s; fine'")).toBe("select '           '");
  });

  it("strips fences, trailing semicolons and trailing comments", () => {
    expect(normalizeSql("```sql\nSELECT 1;\n```")).toBe("SELECT 1");
    expect(normalizeSql("SELECT 1 ;; -- done\n")).toBe("SELECT 1");
    expect(normalizeSql("SELECT ';'")).toBe("SELECT ';'");
  });
});

describe("sqlProblem", () => {
  it("accepts single read queries", () => {
    expect(sqlProblem("SELECT count(*) AS n FROM orders")).toBeNull();
    expect(sqlProblem("WITH x AS (SELECT 1) SELECT * FROM x")).toBeNull();
    expect(sqlProblem("SELECT updated_at, 'delete me' AS note FROM t")).toBeNull();
  });

  it("flags writes as write intent", () => {
    expect(sqlProblem("DELETE FROM orders")?.write).toBe(true);
    expect(sqlProblem("WITH d AS (DELETE FROM t RETURNING *) SELECT * FROM d")?.write).toBe(true);
    expect(sqlProblem("SELECT * INTO copy FROM t")).toMatchObject({ write: true, message: /INTO/ });
    expect(sqlProblem("SELECT * FROM t FOR UPDATE")?.write).toBe(true);
  });

  it("rejects several statements, non-queries and side-effect functions", () => {
    expect(sqlProblem("SELECT 1; SELECT 2")).toMatchObject({ write: false, message: /single/ });
    expect(sqlProblem("EXPLAIN SELECT 1")).toMatchObject({ write: false, message: /EXPLAIN/ });
    expect(sqlProblem("SELECT pg_sleep(10)")).toMatchObject({ write: false, message: /pg_sleep/ });
    expect(sqlProblem("-- nothing")?.write).toBe(false);
  });
});

describe("firstTable", () => {
  it("finds the least-nested real table", () => {
    expect(firstTable("SELECT extract(year FROM created_at) AS y, count(*) FROM orders GROUP BY 1")).toBe("orders");
    expect(firstTable('SELECT * FROM public."Order Items" oi')).toBe("Order Items");
    expect(firstTable("SELECT * FROM Customers")).toBe("customers");
  });

  it("skips CTE names and subqueries", () => {
    expect(firstTable("WITH totals AS (SELECT * FROM orders) SELECT * FROM totals")).toBe("orders");
    expect(firstTable("SELECT * FROM (SELECT * FROM events) e")).toBe("events");
    expect(firstTable("SELECT 1")).toBeUndefined();
  });
});

describe("normalizePlan (postgres)", () => {
  const base: VizPlan = { kind: "sql", explanation: "x", sql: "SELECT status, count(*) AS n FROM orders GROUP BY 1;" };

  it("cleans the SQL and fills the primary table", () => {
    const p = normalizePlan(base, true, "postgres");
    expect(p.sql).toBe("SELECT status, count(*) AS n FROM orders GROUP BY 1");
    expect(p.collection).toBe("orders");
    expect(normalizePlan({ ...base, collection: "customers" }, true, "postgres").collection).toBe("customers");
  });

  it("turns writes into write intent and rejects the rest", () => {
    expect(normalizePlan({ ...base, sql: "TRUNCATE orders" }, false, "postgres").writeIntent).toBe(true);
    expect(normalizePlan({ ...base, sql: "", writeIntent: true }, false, "postgres").writeIntent).toBe(true);
    expect(() => normalizePlan({ ...base, sql: "SELECT 1; SELECT 2" }, false, "postgres")).toThrow(/single/);
    expect(() => normalizePlan({ kind: "aggregate", explanation: "", stages: [] }, false, "postgres")).toThrow(/MongoDB/);
  });

  it("maps chart kinds like MongoDB plans", () => {
    const chart = { labelField: "status", valueField: "n" };
    expect(normalizePlan({ ...base, chart: { ...chart, type: "pie" as never } }, false, "postgres").chart?.type).toBe("donut");
  });

  it("renders SQL for the shell", () => {
    expect(planToShell(normalizePlan(base, false, "postgres"), "orders")).toBe(
      "SELECT status, count(*) AS n FROM orders GROUP BY 1;"
    );
  });
});

describe("sqlSchemaBlock", () => {
  it("lists typed columns, keys and foreign keys", () => {
    const block = sqlSchemaBlock({
      orders: {
        columns: [
          { name: "id", type: "integer" },
          { name: "customer_id", type: "integer" },
          { name: "created_at", type: "timestamp with time zone" },
        ],
        primaryKey: ["id"],
        refs: [{ field: "customer_id", to: "customers" }],
      },
      customers: { kind: "view", columns: [{ name: "id", type: "character varying(20)" }], primaryKey: ["id"], refs: [] },
    });
    expect(block).toBe(
      "- orders (id integer PK, customer_id integer, created_at timestamptz) FK: customer_id -> customers(id)\n" +
        "- customers [view] (id varchar(20) PK)"
    );
    expect(shortType("double precision")).toBe("float8");
  });
});

describe("assistActions", () => {
  it("switches to SQL actions for Postgres only", () => {
    expect(assistActions("mongo")).toBe(ASSIST_ACTIONS);
    expect(assistActions("postgres")).toBe(SQL_ASSIST_ACTIONS);
    expect(SQL_ASSIST_ACTIONS.map((a) => a.id)).toEqual(ASSIST_ACTIONS.map((a) => a.id));
  });
});

describe("formatUsage", () => {
  it("formats tokens and cost", () => {
    expect(formatUsage({ input: 0, output: 0, total: 1234, cost: 0.0031 })).toBe("1.2k tokens · $0.0031");
    expect(formatUsage({ input: 0, output: 0, total: 80, cost: 0 })).toBe("80 tokens");
  });
});

describe("normalizeChart", () => {
  it("keeps new chart types and series fields", () => {
    expect(normalizeChart({ type: "stacked", labelField: "m", valueField: "n", seriesField: "s" })).toEqual({
      type: "stacked",
      labelField: "m",
      valueField: "n",
      seriesField: "s",
      title: undefined,
    });
    expect(normalizeChart({ type: "heatmap" as never, labelField: "hour", valueField: "n", seriesField: "weekday" })?.type).toBe("heatmap");
  });

  it("maps aliases and falls back to bars", () => {
    expect(normalizeChart({ type: "pie" as never, labelField: "k", valueField: "v" })?.type).toBe("donut");
    expect(normalizeChart({ type: "sparkles" as never, labelField: "k", valueField: "v" })?.type).toBe("bar");
  });

  it("downgrades series forms without a second dimension", () => {
    expect(normalizeChart({ type: "stacked", labelField: "k", valueField: "v" })?.type).toBe("bar");
    expect(normalizeChart({ type: "heatmap", labelField: "k", valueField: "v" })?.type).toBe("column");
  });

  it("drops a series field equal to the label and needs a value", () => {
    expect(normalizeChart({ type: "line", labelField: "k", valueField: "v", seriesField: "k" })?.seriesField).toBeUndefined();
    expect(normalizeChart({ type: "bar", labelField: "k", valueField: "" })).toBeNull();
    expect(normalizeChart({ type: "line", labelField: "d", valueField: "", valueFields: ["a", "b"] })).toMatchObject({ valueField: "a", valueFields: ["a", "b"] });
  });
});
