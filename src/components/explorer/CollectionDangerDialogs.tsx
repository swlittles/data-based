import { useEffect, useState } from "react";
import { Loader2, TriangleAlert } from "lucide-react";
import { toast } from "sonner";
import { save } from "@tauri-apps/plugin-dialog";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useExplorer } from "@/stores/explorer";
import { useConnections, useEngine } from "@/stores/connections";
import { api, errMsg } from "@/lib/api";
import { formatCount } from "@/lib/bson";
import { terms } from "@/lib/engine";
import { runExport, type ExportFormat } from "@/lib/files";
import { CheckRow } from "@/components/ui/check-row";

export type CollTarget = { db: string; coll: string } | null;

/** What a PostgreSQL relation kind is called in the UI. */
const PG_KIND_WORD: Record<string, string> = {
  table: "table",
  partitioned: "partitioned table",
  view: "view",
  matview: "materialized view",
  foreign: "foreign table",
};

/** The target's kind from the loaded collection list ("collection", "view",
 *  "table", "matview", ...). */
function useTargetKind(target: CollTarget): string {
  const colls = useExplorer((s) => (target ? s.collections[target.db] : undefined));
  return colls?.find((c) => c.name === target?.coll)?.kind ?? "";
}

function useCollectionFacts(target: CollTarget, withCount = true) {
  const [count, setCount] = useState<number | null>(null);
  const [indexes, setIndexes] = useState<number | null>(null);
  useEffect(() => {
    setCount(null);
    setIndexes(null);
    if (!target) return;
    let stale = false;
    if (withCount) {
      void api
        .countDocuments(target.db, target.coll, "")
        .then((c) => !stale && setCount(c.count ?? null))
        .catch(() => {});
    }
    void api
      .listIndexes(target.db, target.coll)
      .then((ix) => !stale && setIndexes(ix.length))
      .catch(() => {});
    return () => {
      stale = true;
    };
  }, [target?.db, target?.coll, withCount]); // eslint-disable-line react-hooks/exhaustive-deps
  return { count, indexes };
}

/** Optional pre-flight export used by both dialogs. Returns false if the
 *  user cancelled the file picker (the destructive action is then aborted). */
async function backupFirst(target: { db: string; coll: string }, format: ExportFormat): Promise<boolean> {
  const path = await save({
    title: `Backup ${target.coll} before removing`,
    defaultPath: `${target.coll}-backup.${format}`,
    filters: [{ name: format.toUpperCase(), extensions: [format] }],
  }).catch(() => null);
  if (!path) return false;
  const outcome = await runExport({
    database: target.db,
    collection: target.coll,
    filter: "",
    sort: "",
    format,
    path,
  });
  return !!outcome && !outcome.canceled;
}

/**
 * Drop collection: the design's confirm - facts, type-the-name, optional
 * BSON dump first, outline-danger action. PostgreSQL drops the table / view /
 * materialized view / foreign table by kind; the optional export is JSON,
 * NDJSON or CSV (there is no BSON for rows).
 */
export function DropCollectionDialog({
  target,
  onOpenChange,
}: {
  target: CollTarget;
  onOpenChange: (open: boolean) => void;
}) {
  const active = useConnections((s) => s.active);
  const closeTabsForCollection = useExplorer((s) => s.closeTabsForCollection);
  const loadCollections = useExplorer((s) => s.loadCollections);
  const engine = useEngine();
  const pg = engine === "postgres";
  const t = terms(engine);
  const kind = useTargetKind(target);
  // A plain view holds no rows of its own - dropping it only removes the definition.
  const plainView = pg && kind === "view";
  const what = pg ? PG_KIND_WORD[kind] ?? "table" : "collection";
  const { count, indexes } = useCollectionFacts(target, !plainView);
  const [typed, setTyped] = useState("");
  const [backup, setBackup] = useState(false);
  const [format, setFormat] = useState<ExportFormat>("json");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (target) {
      setTyped("");
      setBackup(false);
      setFormat("json");
      setBusy(false);
    }
  }, [target]);

  const ok = !!target && typed.trim() === target.coll;

  const run = async () => {
    if (!target || !ok) return;
    setBusy(true);
    try {
      if (backup) {
        const done = await backupFirst(target, pg ? format : "bson");
        if (!done) {
          toast.info("Drop cancelled - no backup was written");
          setBusy(false);
          return;
        }
      }
      await api.dropCollection(target.db, target.coll);
      toast.success(`Dropped ${target.coll}`);
      closeTabsForCollection(target.db, target.coll);
      await loadCollections(target.db);
      onOpenChange(false);
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={!!target} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent className="max-w-[520px]">
        <DialogHeader>
          <DialogTitle>Drop {what}</DialogTitle>
          <DialogDescription>
            {active?.name} · {target?.db}.{target?.coll}
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          <div className="warnbox">
            <TriangleAlert />
            <div>
              {plainView ? (
                <>
                  This removes the <b>view definition</b>. The {t.docs} it reads from are not touched.
                </>
              ) : (
                <>
                  This removes{" "}
                  <b>
                    {count === null ? "all" : formatCount(count)} {t.docs}
                  </b>
                  {indexes !== null && ` and ${indexes} index${indexes === 1 ? "" : "es"}`}.
                </>
              )}{" "}
              It cannot be undone from Mongo Bongo - there is no local snapshot of this {what}.
              {pg &&
                " PostgreSQL refuses the drop while other tables' foreign keys or other views depend on it (there is no CASCADE here)."}
            </div>
          </div>
          <div className="fld">
            <label htmlFor="drop-confirm">Type the {what} name to confirm</label>
            <input
              id="drop-confirm"
              className="in"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && ok && !busy && void run()}
              placeholder={target?.coll}
              autoComplete="off"
              spellCheck={false}
              autoFocus
            />
          </div>
          <CheckRow on={backup} onChange={setBackup}>
            {pg ? `Export its ${t.docs} first (you choose where)` : "Export a BSON dump first (you choose where)"}
          </CheckRow>
          {pg && backup && (
            <div className="seg self-start" role="radiogroup" aria-label="Backup format">
              {(["json", "ndjson", "csv"] as const).map((f) => (
                <button
                  key={f}
                  role="radio"
                  aria-checked={format === f}
                  className={format === f ? "on" : ""}
                  onClick={() => setFormat(f)}
                  disabled={busy}
                >
                  {f.toUpperCase()}
                </button>
              ))}
            </div>
          )}
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button variant="destructive" disabled={!ok || busy} onClick={() => void run()}>
            {busy && <Loader2 className="spin" />}
            Drop {what}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Clear collection: same shape, keeps the collection and its indexes. */
export function ClearCollectionDialog({
  target,
  onOpenChange,
}: {
  target: CollTarget;
  onOpenChange: (open: boolean) => void;
}) {
  const active = useConnections((s) => s.active);
  const refreshTabsForCollection = useExplorer((s) => s.refreshTabsForCollection);
  const engine = useEngine();
  const pg = engine === "postgres";
  const t = terms(engine);
  const { count } = useCollectionFacts(target);
  const [typed, setTyped] = useState("");
  const [backup, setBackup] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (target) {
      setTyped("");
      setBackup(false);
      setBusy(false);
    }
  }, [target]);

  const ok = !!target && typed.trim() === target.coll;

  const run = async () => {
    if (!target || !ok) return;
    setBusy(true);
    try {
      if (backup) {
        const done = await backupFirst(target, "json");
        if (!done) {
          toast.info("Clear cancelled - no backup was written");
          setBusy(false);
          return;
        }
      }
      const deleted = await api.clearCollection(target.db, target.coll);
      toast.success(`Cleared ${target.coll} - ${formatCount(deleted)} ${deleted === 1 ? t.doc : t.docs} removed`);
      refreshTabsForCollection(target.db, target.coll);
      onOpenChange(false);
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={!!target} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent className="max-w-[520px]">
        <DialogHeader>
          <DialogTitle>Clear {t.coll}</DialogTitle>
          <DialogDescription>
            {active?.name} · {target?.db}.{target?.coll}
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          <div className="warnbox">
            <TriangleAlert />
            <div>
              This deletes <b>{count === null ? "every" : formatCount(count)} {count === 1 ? t.doc : t.docs}</b>{" "}
              in the {t.coll}. The {t.coll} and its indexes stay. It cannot be undone from Mongo Bongo.
              {pg &&
                " It runs DELETE FROM, so triggers fire and rows still referenced by another table's foreign key make the whole clear fail."}
            </div>
          </div>
          <div className="fld">
            <label htmlFor="clear-confirm">Type the {t.coll} name to confirm</label>
            <input
              id="clear-confirm"
              className="in"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && ok && !busy && void run()}
              placeholder={target?.coll}
              autoComplete="off"
              spellCheck={false}
              autoFocus
            />
          </div>
          <CheckRow on={backup} onChange={setBackup}>
            Export a JSON backup first (you choose where)
          </CheckRow>
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button variant="destructive" disabled={!ok || busy} onClick={() => void run()}>
            {busy && <Loader2 className="spin" />}
            Clear {t.coll}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
