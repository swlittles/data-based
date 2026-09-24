import { create } from "zustand";
import { persist } from "zustand/middleware";

/**
 * Saved Studio questions. Running one restores its database + scope and asks
 * again, so the query regenerates against current data and schema.
 */
export interface Insight {
  id: string;
  connection: string;
  prompt: string;
  database: string;
  /** Collection name, or WHOLE_DB. */
  scope: string;
  createdAt: number;
}

interface InsightsState {
  insights: Insight[];
  addInsight: (i: Omit<Insight, "id" | "createdAt">) => void;
  removeInsight: (id: string) => void;
}

const MAX_INSIGHTS = 50;

export const sameInsight = (a: Omit<Insight, "id" | "createdAt">, b: Omit<Insight, "id" | "createdAt">) =>
  a.connection === b.connection && a.prompt === b.prompt && a.database === b.database && a.scope === b.scope;

export const useInsights = create<InsightsState>()(
  persist(
    (set) => ({
      insights: [],
      addInsight: (i) =>
        set((s) =>
          s.insights.some((x) => sameInsight(x, i))
            ? s
            : { insights: [{ ...i, id: crypto.randomUUID(), createdAt: Date.now() }, ...s.insights].slice(0, MAX_INSIGHTS) }
        ),
      removeInsight: (id) => set((s) => ({ insights: s.insights.filter((i) => i.id !== id) })),
    }),
    { name: "mongo-bongo-insights", version: 1 }
  )
);
