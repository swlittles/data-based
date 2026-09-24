import { describe, expect, it } from "vitest";
import { asLabel, asNumber, chartFromDocs, docsToCsv, relTime } from "./studio";
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
      values: [3, 9],
    });
  });

  it("returns null when nothing is plottable", () => {
    expect(chartFromDocs([{ _id: "a" }], plan, "bar")).toBeNull();
    expect(chartFromDocs([{ _id: "a", total: { n: 1 } }], { ...plan, chart: null }, "bar")).toBeNull();
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
