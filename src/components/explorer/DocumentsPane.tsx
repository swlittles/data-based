import { useEffect, useMemo, useState } from "react";
import { AlertCircle, Loader2, Trash2 } from "lucide-react";
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
import { ResultsViewer, docSelectionKey, type DocSelection } from "@/components/explorer/ResultsViewer";
import { CheckRow } from "@/components/ui/check-row";
import { Blank } from "@/components/layout/Blank";
import { useExplorer, type Tab } from "@/stores/explorer";
import { useSettings } from "@/stores/settings";
import { useConnections } from "@/stores/connections";
import { api, errMsg, type Doc } from "@/lib/api";
import { runExport } from "@/lib/files";
import { formatCount } from "@/lib/bson";
import { canAddress, idsFilter, rowId, rowLabel, stripGenerated, terms } from "@/lib/engine";
import { useIdentity } from "@/components/explorer/useIdentity";

/**
 * Find results for the Table / Documents views. The query itself lives in
 * the dock below; this pane renders results, the multi-select bar and errors.
 * Clicking a row opens it in the drawer.
 */
export function DocumentsPane({ tab }: { tab: Tab }) {
  const patchDocs = useExplorer((s) => s.patchDocs);
  const runFind = useExplorer((s) => s.runFind);
  const setDrawer = useExplorer((s) => s.setDrawer);
  const readOnly = useConnections(
    (s) => s.workspaces.find((w) => w.info.id === s.activeId)?.readOnly ?? false
  );
  const offerBackup = useSettings((s) => s.offerBackupOnDelete);
  const ident = useIdentity(tab);
  const pg = ident.engine === "postgres";
  const t = terms(ident.engine);
  const canWrite = !readOnly && ident.editable;
  const columnTypes = useMemo(
    () => (tab.meta ? Object.fromEntries(tab.meta.columns.map((c) => [c.name, c.dataType])) : undefined),
    [tab.meta]
  );
  const d = tab.docs;
  const view = tab.mode === "documents" ? "json" : "table";

  const [confirmSelected, setConfirmSelected] = useState(false);
  const [deletingSelected, setDeletingSelected] = useState(false);
  const [backupSelected, setBackupSelected] = useState(false);
  const [confirmOne, setConfirmOne] = useState<Doc | null>(null);

  const run = (resetPage: boolean) => void runFind(tab.id, { resetPage });

  // Stable identity so the memoized ResultsViewer doesn't re-render on every
  // keystroke in the dock.
  // Table rows open the drawer on Fields; document cards open it on JSON.
  const initialView = view === "json" ? "json" : "fields";
  const actions = useMemo(
    () => ({
      onView: (doc: Doc) => setDrawer(tab.id, { kind: "doc", doc, source: "docs", view: initialView }),
      onEdit: !canWrite
        ? undefined
        : (doc: Doc) => setDrawer(tab.id, { kind: "doc", doc, source: "docs", view: initialView }),
      onDuplicate: !canWrite
        ? undefined
        : (doc: Doc) => setDrawer(tab.id, { kind: "insert", template: pg ? stripGenerated(doc, tab.meta) : doc }),
      onDelete: !canWrite ? undefined : (doc: Doc) => setConfirmOne(doc),
    }),
    [tab.id, setDrawer, canWrite, initialView, pg, tab.meta]
  );

  const selectedDoc = tab.drawer.kind === "doc" ? tab.drawer.doc : null;
  const selectedKey = selectedDoc ? docSelectionKey(selectedDoc, ident) : null;

  // ---- multi-select (table view) ------------------------------------------
  const [selected, setSelected] = useState<Set<string>>(new Set());
  useEffect(() => setSelected(new Set()), [d.docs]);
  const selection: DocSelection = useMemo(
    () => ({
      selected,
      onToggle: (key, on) =>
        setSelected((s) => {
          const next = new Set(s);
          if (on) next.add(key);
          else next.delete(key);
          return next;
        }),
      onToggleAll: (keys, on) =>
        setSelected((s) => {
          const next = new Set(s);
          for (const k of keys) {
            if (on) next.add(k);
            else next.delete(k);
          }
          return next;
        }),
    }),
    [selected]
  );

  const selectedIds = () =>
    d.docs
      .filter((doc) => {
        const k = docSelectionKey(doc, ident);
        return k !== null && selected.has(k);
      })
      .map((doc) => rowId(doc, ident));

  const deleteSelected = async () => {
    const ids = selectedIds();
    if (ids.length === 0) return;
    setDeletingSelected(true);
    try {
      const filter = idsFilter(ids, ident);
      if (backupSelected) {
        const path = await save({
          title: `Backup ${ids.length} ${ids.length === 1 ? t.doc : t.docs} before deleting`,
          defaultPath: `${tab.collection}-${ids.length}-${pg ? "rows" : "docs"}.json`,
          filters: [{ name: "JSON", extensions: ["json"] }],
        }).catch(() => null);
        if (!path) {
          toast.info("Delete cancelled - no backup was written");
          setDeletingSelected(false);
          return;
        }
        const out = await runExport({
          database: tab.database,
          collection: tab.collection,
          filter,
          sort: "",
          format: "json",
          path,
        });
        if (!out || out.canceled) {
          setDeletingSelected(false);
          return;
        }
      }
      const r = await api.bulkDelete(tab.database, tab.collection, filter);
      toast.success(`Deleted ${formatCount(r.deleted)} ${r.deleted === 1 ? t.doc : t.docs}`);
      setConfirmSelected(false);
      setSelected(new Set());
      run(false);
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setDeletingSelected(false);
    }
  };

  const [deletingOne, setDeletingOne] = useState(false);
  const deleteOne = async () => {
    if (!confirmOne) return;
    setDeletingOne(true);
    try {
      if (!canAddress(confirmOne, ident)) throw new Error(`This ${t.doc} can't be addressed individually`);
      await api.deleteDocument(tab.database, tab.collection, rowId(confirmOne, ident));
      toast.success(`${t.Doc} deleted`);
      if (selectedKey && selectedKey === docSelectionKey(confirmOne, ident)) setDrawer(tab.id, { kind: "closed" });
      setConfirmOne(null);
      run(false);
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setDeletingOne(false);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {d.error && (
        <div className="notice dgr mono mx-[var(--pad)] mt-3 shrink-0">
          <AlertCircle />
          <span className="min-w-0 flex-1 break-all">{d.error}</span>
        </div>
      )}

      {selected.size > 0 && (
        <div className="notice acc mx-[var(--pad)] mt-3 shrink-0 items-center py-1.5 no-select">
          <span className="font-mono text-[11.5px] text-text">
            {selected.size} {selected.size === 1 ? t.doc : t.docs} selected
          </span>
          <div className="grow" />
          <button className="btn qt sm" onClick={() => setSelected(new Set())}>
            Clear
          </button>
          <button
            className="btn dgr sm"
            disabled={readOnly}
            onClick={() => {
              setBackupSelected(false);
              setConfirmSelected(true);
            }}
          >
            <Trash2 />
            Delete {selected.size}
          </button>
        </div>
      )}

      {d.loading && d.docs.length === 0 ? (
        <div className="flex flex-1 items-center justify-center">
          <Loader2 className="spin h-5 w-5 text-text-3" />
        </div>
      ) : d.docs.length === 0 && !d.loading ? (
        <Blank
          small
          title={d.filter.trim() ? `No ${t.docs} match this ${pg ? "condition" : "filter"}` : `This ${t.coll} is empty`}
          text={
            d.filter.trim() ? (
              <>
                Nothing in <span className="mono">{tab.collection}</span> matches{" "}
                <span className="mono">{d.filter.trim()}</span>. Loosen the filter or check field names and
                types.
              </>
            ) : readOnly ? (
              `Switch to edit mode to insert the first ${t.doc}.`
            ) : !ident.editable ? (
              `This ${tab.meta?.kind === "matview" ? "materialized view" : "view"} returns no rows.`
            ) : pg ? (
              "Insert adds the first row, or import a JSON / CSV file."
            ) : (
              "Insert adds the first document, or import a JSON / CSV / BSON file."
            )
          }
          actions={
            d.filter.trim() ? (
              <>
                <button
                  className="btn"
                  onClick={() => {
                    patchDocs(tab.id, { filter: "" });
                    run(true);
                  }}
                >
                  Clear filter
                </button>
                <button
                  className="btn qt"
                  onClick={() => document.querySelector<HTMLTextAreaElement>('.dock [aria-label="Filter"] textarea')?.focus()}
                >
                  Edit filter
                </button>
              </>
            ) : canWrite ? (
              <button className="btn pri" onClick={() => setDrawer(tab.id, { kind: "insert" })}>
                Insert a {t.doc}
              </button>
            ) : undefined
          }
        />
      ) : (
        <ResultsViewer
          docs={d.docs}
          view={view}
          actions={actions}
          selection={view === "table" ? selection : undefined}
          activeKey={selectedKey}
          identity={ident}
          columnTypes={columnTypes}
          emptyText={`No ${t.docs} match`}
        />
      )}

      {/* delete selected */}
      <Dialog open={confirmSelected} onOpenChange={(o) => !o && !deletingSelected && setConfirmSelected(false)}>
        <DialogContent className="max-w-[480px]">
          <DialogHeader>
            <DialogTitle>Delete {selected.size} selected {selected.size === 1 ? t.doc : t.docs}?</DialogTitle>
            <DialogDescription>
              {tab.database}.{tab.collection}
            </DialogDescription>
          </DialogHeader>
          <DialogBody>
            <div className="warnbox">
              <Trash2 />
              <div>
                The selected {t.docs} are permanently removed from the {t.coll}. It cannot be undone
                from Mongo Bongo.
              </div>
            </div>
            {offerBackup && (
              <CheckRow on={backupSelected} onChange={setBackupSelected}>
                Export the selected {t.docs} to a JSON file first
              </CheckRow>
            )}
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" disabled={deletingSelected} onClick={() => setConfirmSelected(false)}>
              Cancel
            </Button>
            <Button variant="destructive" disabled={deletingSelected} onClick={() => void deleteSelected()}>
              {deletingSelected && <Loader2 className="spin" />}
              Delete {selected.size}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* delete one */}
      <Dialog open={!!confirmOne} onOpenChange={(o) => !o && !deletingOne && setConfirmOne(null)}>
        <DialogContent className="max-w-[440px]">
          <DialogHeader>
            <DialogTitle>Delete {t.doc}?</DialogTitle>
            <DialogDescription>
              {tab.database}.{tab.collection}
            </DialogDescription>
          </DialogHeader>
          <DialogBody>
            <div className="warnbox">
              <Trash2 />
              <div>
                <span className="mono">{confirmOne ? rowLabel(confirmOne, ident) : ""}</span> will be removed.
                It cannot be undone from Mongo Bongo.
              </div>
            </div>
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" disabled={deletingOne} onClick={() => setConfirmOne(null)}>
              Cancel
            </Button>
            <Button variant="destructive" disabled={deletingOne} onClick={() => void deleteOne()}>
              {deletingOne && <Loader2 className="spin" />}
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
