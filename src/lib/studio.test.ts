import { describe, expect, it } from "vitest";
import { asLabel, asNumber, chartFromDocs, chartKindsFor, docsToCsv, OTHER, relTime } from "./studio";
import { compact, niceTicks } from "@/components/studio/Chart";
import type { VizPlan } from "./ai";

describe("asNumber / asLabel", () => {
  it("reads extended JSON numbers", () => {
    expect(asNumber(3)).toBe(3);
    expect(asNumber({ $numberLong: "42" })).toBe(42);
    expect(asNumber({ $numberDecimal: "1.5" })).toBe(1.5);
    expect(asNumber("7")).toBe(7);
    expect(asNumber("")).toBeNull();
    expect(asNumber(true)).toBeNull();
    expect(asNumber({ a: 1 })).toBeNull();
  });

  it("labels ids, dates and nulls", () => {
    expect(asLabel({ $oid: "65a1b2c3d4e5f60718293a4b" })).toBe("…293a4b");
    expect(asLabel({ $date: "2026-03-01T00:00:00Z" })).toBe("2026-03-01");
    expect(asLabel({ $date: "2026-03-01T14:05:00.000Z" })).toBe("2026-03-01 14:05:00");
    expect(asLabel(null)).toBe("(none)");
    expect(asLabel("paid")).toBe("paid");
  });
});

describe("chartFromDocs", () => {
  const plan: VizPlan = {
    kind: "aggregate",
    explanation: "",
    chart: { type: "bar", labelField: "_id", valueField: "total.n" },
  };

  it("pulls nested values and skips non-numeric rows", () => {
    const docs = [
      { _id: "a", total: { n: 3 } },
      { _id: "b", total: { n: "x" } },
      { _id: "c", total: { n: { $numberLong: "9" } } },
    ];
    expect(chartFromDocs(docs, plan, "bar")).toEqual({
      kind: "bar",
      title: undefined,
      metric: "total.n",
      labels: ["a", "c"],
      series: [{ name: "total.n", values: [3, 9], other: false }],
    });
  });

  it("reads SQL rows: aliased columns, big numbers as strings", () => {
    const sql: VizPlan = { kind: "sql", explanation: "", chart: { type: "line", labelField: "day", valueField: "revenue" } };
    const rows = [
      { day: "2026-03-01", revenue: "9007199254740993" },
      { day: "2026-03-02", revenue: 12.5 },
      { day: "2026-03-03", revenue: null },
    ];
    expect(chartFromDocs(rows, sql, "line")).toMatchObject({
      labels: ["2026-03-01", "2026-03-02"],
      series: [{ values: [9007199254740993, 12.5] }],
    });
  });

  it("returns null when nothing is plottable", () => {
    expect(chartFromDocs([{ _id: "a" }], plan, "bar")).toBeNull();
    expect(chartFromDocs([{ _id: "a", total: { n: 1 } }], { ...plan, chart: null }, "bar")).toBeNull();
  });
});

describe("multi-series charts", () => {
  const long: VizPlan = {
    kind: "sql",
    explanation: "",
    chart: { type: "stacked", labelField: "month", valueField: "n", seriesField: "status" },
  };
  const rows = [
    { month: "2026-01", status: "paid", n: 5 },
    { month: "2026-01", status: "refunded", n: 1 },
    { month: "2026-02", status: "paid", n: 7 },
    { month: "2026-02", status: "pending", n: 2 },
  ];

  it("pivots long rows into one series per value, gaps as null", () => {
    expect(chartFromDocs(rows, long, "stacked")).toMatchObject({
      labels: ["2026-01", "2026-02"],
      series: [
        { name: "paid", values: [5, 7] },
        { name: "refunded", values: [1, null] },
        { name: "pending", values: [null, 2] },
      ],
    });
  });

  it("reads wide rows as one series per value field", () => {
    const wide: VizPlan = { kind: "sql", explanation: "", chart: { type: "line", labelField: "day", valueField: "a", valueFields: ["a", "b"] } };
    const c = chartFromDocs([{ day: "d1", a: 1, b: 2 }, { day: "d2", a: 3, b: 4 }], wide, "line");
    expect(c?.series.map((s) => [s.name, s.values])).toEqual([["a", [1, 3]], ["b", [2, 4]]]);
  });

  it("folds series past the palette into Other, keeping the biggest", () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ month: "m", status: `s${i}`, n: i + 1 }));
    const c = chartFromDocs(many, long, "column")!;
    expect(c.series).toHaveLength(8);
    expect(c.series[7]).toMatchObject({ name: OTHER, other: true, values: [1 + 2 + 3 + 4 + 5] });
    // Survivors keep first-appearance order (colour follows the entity).
    expect(c.series.slice(0, 7).map((s) => s.name)).toEqual(["s5", "s6", "s7", "s8", "s9", "s10", "s11"]);
  });

  it("keeps a real category named Other", () => {
    const c = chartFromDocs([{ month: "m", status: "Other", n: 1 }, { month: "m", status: "paid", n: 2 }], long, "column")!;
    expect(c.series.map((s) => [s.name, s.other])).toEqual([["Other", false], ["paid", false]]);
  });

  it("offers only the forms the data fits", () => {
    expect(chartKindsFor(rows, long)).toEqual(["stacked", "column", "bar", "line", "heatmap"]);
    const single: VizPlan = { kind: "sql", explanation: "", chart: { type: "bar", labelField: "k", valueField: "v" } };
    expect(chartKindsFor([{ k: "a", v: 1 }, { k: "b", v: 2 }], single)).toEqual(["bar", "column", "line", "area", "donut", "number"]);
    expect(chartKindsFor([{ k: "a", v: -1 }, { k: "b", v: 2 }], single)).not.toContain("donut");
  });
});

describe("donut and scatter", () => {
  const plan: VizPlan = { kind: "sql", explanation: "", chart: { type: "donut", labelField: "k", valueField: "v" } };

  it("keeps five slices and folds the tail into Other", () => {
    const rows = [10, 9, 8, 7, 6, 5, 4].map((v, i) => ({ k: `c${i}`, v }));
    const c = chartFromDocs(rows, plan, "donut")!;
    expect(c.labels).toEqual(["c0", "c1", "c2", "c3", "c4", OTHER]);
    expect(c.series[0].values).toEqual([10, 9, 8, 7, 6, 9]);
  });

  it("refuses negative shares", () => {
    expect(chartFromDocs([{ k: "a", v: -1 }, { k: "b", v: 3 }], plan, "donut")).toBeNull();
  });

  it("plots numeric x/y points, three series at most", () => {
    const sc: VizPlan = { kind: "sql", explanation: "", chart: { type: "scatter", labelField: "price", valueField: "sold", seriesField: "cat" } };
    const rows = ["a", "b", "c", "d"].flatMap((cat, i) => [{ price: i, sold: i * 2, cat }, { price: i + 0.5, sold: i, cat }]);
    const c = chartFromDocs(rows, sc, "scatter")!;
    expect(c.points).toHaveLength(8);
    expect(c.series).toHaveLength(3);
    expect(c.series[2]).toMatchObject({ name: OTHER, other: true });
    expect(chartKindsFor(rows, sc)).toContain("scatter");
  });
});

describe("docsToCsv", () => {
  it("unions columns and escapes", () => {
    expect(docsToCsv([{ a: 1, b: "x,y" }, { a: 2, c: { $oid: "0123456789abcdef01234567" } }])).toBe(
      'a,b,c\n1,"x,y",\n2,,…234567'
    );
  });
});

describe("chart helpers", () => {
  it("compacts numbers", () => {
    expect(compact(950)).toBe("950");
    expect(compact(12900)).toBe("12.9K");
    expect(compact(4_200_000)).toBe("4.2M");
    expect(compact(3_000_000_000)).toBe("3B");
  });

  it("makes clean ticks that cover the range", () => {
    expect(niceTicks(0, 1000)).toEqual([0, 250, 500, 750, 1000]);
    const t = niceTicks(0, 7);
    expect(t[0]).toBe(0);
    expect(t[t.length - 1]).toBeGreaterThanOrEqual(7);
    expect(niceTicks(5, 5).length).toBeGreaterThan(1);
  });

  it("formats relative time", () => {
    const now = 10_000_000;
    expect(relTime(now - 10_000, now)).toBe("just now");
    expect(relTime(now - 5 * 60_000, now)).toBe("5m ago");
    expect(relTime(now - 3 * 3_600_000, now)).toBe("3h ago");
  });
});
