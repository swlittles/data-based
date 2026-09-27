import type { Doc } from "@/lib/api";
import { formatCount } from "@/lib/bson";
import { cn } from "@/lib/utils";

/**
 * A PostgreSQL `EXPLAIN (FORMAT JSON)` plan as a readable tree. With ANALYZE
 * the node where the time goes is highlighted; without it, the costliest one.
 */

type PlanNode = Doc & { Plans?: PlanNode[] };

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

/** Wall time of a node over all its loops (ms), children included. */
function inclusiveMs(n: PlanNode): number | null {
  const t = num(n["Actual Total Time"]);
  return t === null ? null : t * (num(n["Actual Loops"]) ?? 1);
}

/** Time (or cost) spent in the node itself rather than its children. */
function exclusive(n: PlanNode, analyzed: boolean): number {
  const own = analyzed ? inclusiveMs(n) ?? 0 : num(n["Total Cost"]) ?? 0;
  const kids = (n.Plans ?? []).reduce(
    (sum, c) => sum + (analyzed ? inclusiveMs(c) ?? 0 : num(c["Total Cost"]) ?? 0),
    0
  );
  return Math.max(0, own - kids);
}

function countNodes(n: PlanNode): number {
  return 1 + (n.Plans ?? []).reduce((s, c) => s + countNodes(c), 0);
}

const CONDITIONS = ["Index Cond", "Recheck Cond", "Hash Cond", "Merge Cond", "Join Filter", "Filter"] as const;
const REMOVED = [
  ["Rows Removed by Filter", "removed by filter"],
  ["Rows Removed by Index Recheck", "removed by recheck"],
  ["Rows Removed by Join Filter", "removed by join filter"],
] as const;

const fmtMs = (ms: number) => (ms >= 100 ? `${Math.round(ms)} ms` : `${ms.toFixed(ms >= 1 ? 1 : 3)} ms`);
const fmtCost = (c: number) => (c >= 1000 ? formatCount(Math.round(c)) : c.toFixed(2));

interface Ctx {
  analyzed: boolean;
  /** Root inclusive time (ms) or cost - the denominator for shares. */
  total: number;
  many: boolean;
}

export function PgPlanTree({ raw }: { raw: Doc }) {
  const root = raw.Plan as PlanNode | undefined;
  if (!root || typeof root !== "object") return null;
  const analyzed = inclusiveMs(root) !== null;
  const total = (analyzed ? inclusiveMs(root) : num(root["Total Cost"])) ?? 0;
  return (
    <div className="flex flex-col gap-1.5">
      <PlanNodeView node={root} ctx={{ analyzed, total, many: countNodes(root) > 1 }} />
    </div>
  );
}

function PlanNodeView({ node, ctx }: { node: PlanNode; ctx: Ctx }) {
  const type = str(node["Node Type"]) ?? "?";
  const join = str(node["Join Type"]);
  const strategy = str(node["Strategy"]);
  const relation = str(node["Relation Name"]);
  const alias = str(node["Alias"]);
  const index = str(node["Index Name"]);
  const subplan = str(node["Subplan Name"]);

  const self = exclusive(node, ctx.analyzed);
  const share = ctx.total > 0 ? self / ctx.total : 0;
  // Only flag a node when it dominates a plan with more than one step, and
  // (with ANALYZE) when the time is big enough to matter.
  const hot = ctx.many && share >= 0.3 && (!ctx.analyzed || self >= 1);

  const planRows = num(node["Plan Rows"]);
  const actualRows = num(node["Actual Rows"]);
  const loops = num(node["Actual Loops"]);
  const startupCost = num(node["Startup Cost"]);
  const totalCost = num(node["Total Cost"]);
  const startupMs = num(node["Actual Startup Time"]);
  const totalMs = num(node["Actual Total Time"]);
  const hit = num(node["Shared Hit Blocks"]);
  const read = num(node["Shared Read Blocks"]);

  // Estimates off by 10x or more mislead the planner's choices.
  const misestimate =
    planRows !== null && actualRows !== null && Math.max(planRows, actualRows) >= 100
      ? Math.max(planRows, actualRows) / Math.max(1, Math.min(planRows, actualRows))
      : 0;

  const sortKey = Array.isArray(node["Sort Key"]) ? (node["Sort Key"] as unknown[]).join(", ") : null;
  const sortMethod = str(node["Sort Method"]);
  const sortSpace = num(node["Sort Space Used"]);

  return (
    <div className="flex flex-col gap-1.5">
      <div
        className={cn(
          "rounded-[var(--r-sm)] border px-2.5 py-2",
          hot ? "border-warn/50 bg-warn/5" : "border-line bg-panel"
        )}
      >
        <div className="flex items-baseline gap-2">
          <div className="min-w-0 flex-1 truncate font-mono text-[11.5px]">
            {subplan && <span className="mr-1.5 text-text-3">{subplan} ·</span>}
            <span className={cn("font-medium", type === "Seq Scan" ? "text-warn" : "text-text")}>
              {type}
              {join && ` (${join})`}
              {strategy && strategy !== "Plain" && ` (${strategy})`}
            </span>
            {relation && (
              <span className="text-text-2">
                {" "}
                on {relation}
                {alias && alias !== relation && ` ${alias}`}
              </span>
            )}
            {index && (
              <span className="text-text-2">
                {" "}
                using <span className="text-primary">{index}</span>
              </span>
            )}
          </div>
          <span className={cn("shrink-0 font-mono text-[11px] tabular-nums", hot ? "text-warn" : "text-text-3")}>
            {ctx.analyzed ? fmtMs(self) : `cost ${fmtCost(self)}`}
            {ctx.many && ` · ${Math.round(share * 100)}%`}
          </span>
        </div>

        {ctx.many && (
          <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-panel-2">
            <div
              className={cn("h-full rounded-full", hot ? "bg-warn" : "bg-primary/60")}
              style={{ width: `${Math.max(1, Math.round(share * 100))}%` }}
            />
          </div>
        )}

        <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 font-mono text-[10.5px] tabular-nums text-text-3">
          <span>
            rows {planRows === null ? "-" : formatCount(planRows)} est
            {actualRows !== null && ` · ${formatCount(actualRows)} actual`}
            {loops !== null && loops > 1 && ` × ${formatCount(loops)} loops`}
          </span>
          {misestimate >= 10 && (
            <span className="text-warn" title="The planner's row estimate is far from reality - try ANALYZE on the table">
              estimate off {Math.round(misestimate)}x
            </span>
          )}
          {startupCost !== null && totalCost !== null && (
            <span>
              cost {fmtCost(startupCost)}..{fmtCost(totalCost)}
            </span>
          )}
          {startupMs !== null && totalMs !== null && (
            <span>
              time {startupMs.toFixed(3)}..{totalMs.toFixed(3)} ms
            </span>
          )}
          {(hit !== null || read !== null) && (hit || read) ? (
            <span title="Shared buffers: pages found in cache (hit) and read from disk / OS cache (read)">
              buffers hit {formatCount(hit ?? 0)} · read {formatCount(read ?? 0)}
            </span>
          ) : null}
        </div>

        {CONDITIONS.map((k) => {
          const v = str(node[k]);
          return v ? (
            <p key={k} className="mt-1 break-all font-mono text-[10.5px] text-text-2">
              <span className="text-text-3">{k}:</span> {v}
            </p>
          ) : null;
        })}
        {REMOVED.map(([k, label]) => {
          const v = num(node[k]);
          if (!v) return null;
          // Throwing most rows away after reading them is what an index avoids.
          const wasteful = v >= 1000 && v > (actualRows ?? 0) * 10;
          return (
            <p key={k} className={cn("mt-1 font-mono text-[10.5px] tabular-nums", wasteful ? "text-warn" : "text-text-3")}>
              {formatCount(v)} rows {label}
              {loops !== null && loops > 1 && " per loop"}
            </p>
          );
        })}
        {sortKey && (
          <p className="mt-1 break-all font-mono text-[10.5px] text-text-2">
            <span className="text-text-3">Sort Key:</span> {sortKey}
            {sortMethod && (
              <span className="text-text-3">
                {" "}
                · {sortMethod}
                {sortSpace !== null && `, ${formatCount(sortSpace)} kB ${str(node["Sort Space Type"]) ?? ""}`}
              </span>
            )}
          </p>
        )}
      </div>

      {node.Plans && node.Plans.length > 0 && (
        <div className="ml-3 flex flex-col gap-1.5 border-l border-line pl-3">
          {node.Plans.map((c, i) => (
            <PlanNodeView key={i} node={c} ctx={ctx} />
          ))}
        </div>
      )}
    </div>
  );
}
