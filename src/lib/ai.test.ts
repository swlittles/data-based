import { describe, expect, it } from "vitest";
import { extractJson, formatUsage, normalizePlan, planToShell, type VizPlan } from "./ai";

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

  it("maps legacy pie charts to bars and keeps line/number", () => {
    const chart = { labelField: "_id", valueField: "n" };
    expect(normalizePlan({ ...base, chart: { ...chart, type: "pie" as never } }, false).chart?.type).toBe("bar");
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

describe("formatUsage", () => {
  it("formats tokens and cost", () => {
    expect(formatUsage({ input: 0, output: 0, total: 1234, cost: 0.0031 })).toBe("1.2k tokens · $0.0031");
    expect(formatUsage({ input: 0, output: 0, total: 80, cost: 0 })).toBe("80 tokens");
  });
});
