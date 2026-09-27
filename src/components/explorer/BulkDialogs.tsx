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
import { CheckRow } from "@/components/ui/check-row";
import { CodeEditor } from "@/components/CodeEditor";
import { api, errMsg, type Doc } from "@/lib/api";
import { previewValue } from "@/lib/diff";
import { runExport } from "@/lib/files";
import { identityFor, rowIdText, sqlIdent, terms } from "@/lib/engine";
import { useSettings } from "@/stores/settings";
import { useEngine } from "@/stores/connections";

/**
 * Bulk update / delete against the tab's current filter, with an
 * affected-document preview (count + sample ids) before anything runs.
 * PostgreSQL: the filter is a WHERE condition and the update a SET list.
 */

interface BulkProps {
  open: boolean;
  database: string;
  collection: string;
  /** The documents tab's current filter (mongosh-flavored, or a SQL WHERE
   *  condition for PostgreSQL). */
  filter: string;
  onOpenChange: (open: boolean) => void;
  /** Refresh the documents view after a successful mutation. */
  onDone: () => void;
}

/** Matched-count + sample-ids preview shared by both dialogs. */
function AffectedPreview({
  database,
  collection,
  filter,
  active,
}: {
  database: string;
  collection: string;
  filter: string;
  active: boolean;
}) {
  const [count, setCount] = useState<number | null>(null);
  const [exact, setExact] = useState(true);
  const [sample, setSample] = useState<Doc[]>([]);
  const [loading, setLoading] = useState(false);
  const engine = useEngine();
  const t = terms(engine);
  // Sample ids: `_id` for MongoDB, the primary key for PostgreSQL.
  const [idText, setIdText] = useState<(d: Doc) => string>(() => (d: Doc) => previewValue(d._id));

  useEffect(() => {
    if (!active) return;
    let stale = false;
    setLoading(true);
    setCount(null);
    setSample([]);
    void (async () => {
      try {
        let projection = "{ _id: 1 }";
        let label = (d: Doc) => previewValue(d._id);
        if (engine === "postgres") {
          const meta = await api.tableMeta(database, collection).catch(() => null);
          const ident = identityFor(engine, meta);
          projection = ident.key.map(sqlIdent).join(", ");
          label = ident.key.length ? (d: Doc) => rowIdText(d, ident) : () => "";
        }
        const [c, page] = await Promise.all([
          api.countDocuments(database, collection, filter),
          // No primary key: nothing useful to sample.
          projection
            ? api.findDocuments({ database, collection, filter, sort: "", projection, limit: 5, skip: 0 })
            : Promise.resolve({ docs: [] as Doc[] }),
        ]);
        if (stale) return;
        setCount(c.count ?? null);
        setExact(c.exact);
        setSample(page.docs);
        setIdText(() => label);
      } catch {
        if (!stale) setCount(null);
      } finally {
        if (!stale) setLoading(false);
      }
    })();
    return () => {
      stale = true;
    };
  }, [active, database, collection, filter, engine]);

  return (
    <div className="notice">
      {loading ? (
        <>
          <Loader2 className="spin" />
          <span className="text-text-3">counting matching {t.docs}...</span>
        </>
      ) : count === null ? (
        <span className="text-text-3">Match count unavailable (slow count?)</span>
      ) : (
        <div className="min-w-0 flex-1">
          <div>
            <b className="mono font-semibold tabular-nums text-text">{count.toLocaleString()}</b>
            {!exact && "+"} {count === 1 ? t.doc : t.docs} will be affected
          </div>
          {sample.length > 0 && (
            <div className="mt-1 truncate font-mono text-[10.5px] text-text-3">
              e.g. <span className="oi">{sample.map(idText).join(", ")}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function BulkUpdateDialog({
  open,
  database,
  collection,
  filter,
  onOpenChange,
  onDone,
}: BulkProps) {
  const engine = useEngine();
  const pg = engine === "postgres";
  const t = terms(engine);
  const starter = pg ? "" : "{\n  $set: {\n    \n  }\n}";
  const [update, setUpdate] = useState(starter);
  const [busy, setBusy] = useState(false);
  const emptyFilter = !filter.trim() || (!pg && filter.trim() === "{}");

  useEffect(() => {
    if (open) {
      setUpdate(starter);
      setBusy(false);
    }
  }, [open, starter]);

  const run = async () => {
    setBusy(true);
    try {
      const r = await api.bulkUpdate(database, collection, filter, update);
      toast.success(
        `Updated ${r.modified.toLocaleString()} of ${r.matched.toLocaleString()} matched ${r.matched === 1 ? t.doc : t.docs} · ${r.execMs}ms`
      );
      onDone();
      onOpenChange(false);
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent className="max-w-[560px]">
        <DialogHeader>
          <DialogTitle>Bulk update</DialogTitle>
          <DialogDescription>
            {pg
              ? `${database}.${collection} · UPDATE ... SET on every row matching the current WHERE`
              : `${database}.${collection} · operator update on every document matching the current filter`}
          </DialogDescription>
        </DialogHeader>

        <DialogBody>
          <div className="fld">
            <label>{pg ? "WHERE" : "Filter"}</label>
            <input
              className="in"
              value={filter.trim() || (pg ? "(none)" : "{ }")}
              readOnly
              tabIndex={-1}
            />
            {emptyFilter && (
              <div className="hint">{pg ? "No WHERE condition, matches every row." : "Empty filter, matches every document."}</div>
            )}
          </div>
          <AffectedPreview
            database={database}
            collection={collection}
            filter={filter}
            active={open}
          />
          <div className="fld">
            <label>{pg ? "SET" : "Update"}</label>
            <CodeEditor
              value={update}
              onChange={setUpdate}
              height={120}
              path={pg ? "bulk/update.sql" : "bulk/update"}
              language={pg ? "pgsql" : "mongodb"}
            />
            <div className="hint">
              {pg ? (
                <>
                  Comma-separated assignments, e.g.{" "}
                  <span className="mono">status = 'archived', updated_at = now()</span>
                </>
              ) : (
                "Operator syntax: $set, $unset, $inc, ..."
              )}
            </div>
          </div>
        </DialogBody>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button disabled={busy || (pg && !update.trim())} onClick={() => void run()}>
            {busy && <Loader2 className="spin" />}
            Update matching
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function BulkDeleteDialog({
  open,
  database,
  collection,
  filter,
  onOpenChange,
  onDone,
}: BulkProps) {
  const [confirm, setConfirm] = useState("");
  const [backup, setBackup] = useState(false);
  const [busy, setBusy] = useState(false);
  const offerBackup = useSettings((s) => s.offerBackupOnDelete);
  const engine = useEngine();
  const pg = engine === "postgres";
  const t = terms(engine);
  const emptyFilter = !filter.trim() || (!pg && filter.trim() === "{}");

  useEffect(() => {
    if (open) {
      setConfirm("");
      setBackup(false);
      setBusy(false);
    }
  }, [open]);

  const run = async () => {
    setBusy(true);
    try {
      if (offerBackup && backup) {
        const path = await save({
          title: `Backup matching ${t.docs} from ${collection}`,
          defaultPath: `${collection}-bulk-backup.json`,
          filters: [{ name: "JSON", extensions: ["json"] }],
        }).catch(() => null);
        if (!path) {
          toast.info("Delete cancelled - no backup was written");
          setBusy(false);
          return;
        }
        const outcome = await runExport({
          database,
          collection,
          filter,
          sort: "",
          format: "json",
          path,
        });
        if (!outcome || outcome.canceled) {
          toast.info("Delete cancelled - the backup export did not complete");
          setBusy(false);
          return;
        }
      }
      const r = await api.bulkDelete(database, collection, filter);
      toast.success(`Deleted ${r.deleted.toLocaleString()} ${r.deleted === 1 ? t.doc : t.docs} · ${r.execMs}ms`);
      onDone();
      onOpenChange(false);
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  const ok = !emptyFilter && confirm === collection;

  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent className="max-w-[520px]">
        <DialogHeader>
          <DialogTitle>Bulk delete</DialogTitle>
          <DialogDescription>
            {database}.{collection} · every {t.doc} matching the current {pg ? "WHERE" : "filter"}
          </DialogDescription>
        </DialogHeader>

        <DialogBody>
          <div className="fld">
            <label>{pg ? "WHERE" : "Filter"}</label>
            <input className="in" value={filter.trim() || (pg ? "(none)" : "{ }")} readOnly tabIndex={-1} />
          </div>
          {emptyFilter ? (
            <div className="warnbox">
              <TriangleAlert />
              <div>
                {pg ? (
                  <>
                    <b>There is no WHERE condition.</b> Bulk delete refuses to empty a whole table. Use
                    right-click, Clear table for that.
                  </>
                ) : (
                  <>
                    <b>The filter is empty.</b> Bulk delete refuses to wipe a whole collection. Use
                    right-click, Clear collection for that.
                  </>
                )}
              </div>
            </div>
          ) : (
            <>
              <div className="warnbox">
                <TriangleAlert />
                <div>
                  This permanently deletes every matching {t.doc}. It cannot be undone from Data Based.
                </div>
              </div>
              <AffectedPreview
                database={database}
                collection={collection}
                filter={filter}
                active={open}
              />
              <div className="fld">
                <label htmlFor="bulk-delete-confirm">Type the {t.coll} name to confirm</label>
                <input
                  id="bulk-delete-confirm"
                  className="in"
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && ok && !busy && void run()}
                  placeholder={collection}
                  autoComplete="off"
                  spellCheck={false}
                  autoFocus
                />
              </div>
              {offerBackup && (
                <CheckRow on={backup} onChange={setBackup} disabled={busy}>
                  Export the matching {t.docs} to a JSON file first
                </CheckRow>
              )}
            </>
          )}
        </DialogBody>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button variant="destructive" disabled={busy || !ok} onClick={() => void run()}>
            {busy && <Loader2 className="spin" />}
            Delete matching
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
