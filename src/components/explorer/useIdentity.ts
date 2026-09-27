import { useMemo } from "react";
import { useEngine } from "@/stores/connections";
import { identityFor, type RowIdentity } from "@/lib/engine";
import type { Tab } from "@/stores/explorer";

/** How rows of this tab are addressed (MongoDB `_id` or Postgres primary key). */
export function useIdentity(tab: Tab): RowIdentity {
  const engine = useEngine();
  return useMemo(() => identityFor(engine, tab.meta), [engine, tab.meta]);
}
