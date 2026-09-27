import { useEffect, useId, useState } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
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
import { api, errMsg } from "@/lib/api";
import { terms } from "@/lib/engine";
import { useEngine } from "@/stores/connections";

interface DuplicateCollectionDialogProps {
  open: boolean;
  database: string;
  source: string;
  onOpenChange: (open: boolean) => void;
  /** Called after a successful duplicate so the caller can refresh its list. */
  onDuplicated: (newCollection: string) => void;
}

export function DuplicateCollectionDialog({
  open,
  database,
  source,
  onOpenChange,
  onDuplicated,
}: DuplicateCollectionDialogProps) {
  const nameId = useId();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const engine = useEngine();
  const pg = engine === "postgres";
  const t = terms(engine);

  // Prefill "<source>_backup" each time the dialog opens for a collection.
  useEffect(() => {
    if (open) {
      setName(`${source}_backup`);
      setBusy(false);
    }
  }, [open, source]);

  const trimmed = name.trim();
  const canDuplicate = !busy && trimmed.length > 0 && trimmed !== source;
  // PostgreSQL names are used verbatim (quoted), so anything other than a
  // plain lower-case identifier has to be double-quoted in every query.
  const needsQuoting = pg && trimmed.length > 0 && !/^[a-z_][a-z0-9_]*$/.test(trimmed);

  const submit = async () => {
    if (!canDuplicate) return;
    setBusy(true);
    try {
      const { documents, indexes } = await api.duplicateCollection(database, source, trimmed);
      toast.success(
        `Duplicated to "${trimmed}" - ${documents} ${documents === 1 ? t.doc : t.docs}` +
          (indexes > 0 ? `, ${indexes} index${indexes === 1 ? "" : "es"}` : "")
      );
      onDuplicated(trimmed);
      onOpenChange(false);
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent className="max-w-[480px]">
        <DialogHeader>
          <DialogTitle>Duplicate {t.coll}</DialogTitle>
          <DialogDescription>
            {database}.{source}
          </DialogDescription>
        </DialogHeader>

        <DialogBody>
          <p className="text-[12.5px] leading-relaxed text-text-2">
            {pg ? (
              <>
                Create a new table like <span className="mono text-text">{source}</span> (columns, defaults,
                constraints, indexes) in the same schema and copy all of its rows.
              </>
            ) : (
              <>
                Copy all documents and indexes of <span className="mono text-text">{source}</span> into a new
                collection.
              </>
            )}
          </p>
          <div className="fld">
            <label htmlFor={nameId}>New {t.coll} name</label>
            <input
              id={nameId}
              className={trimmed === source ? "in dgr" : "in"}
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && void submit()}
              disabled={busy}
              autoComplete="off"
              spellCheck={false}
              autoFocus
            />
            {trimmed === source && <span className="hint text-danger">Pick a name different from the source.</span>}
            {pg && trimmed !== source && (
              <span className="hint">
                {needsQuoting
                  ? `Used exactly as typed - SQL will need "${trimmed}" in double quotes. Lower-case letters, digits and _ avoid that.`
                  : "Lower-case letters, digits and _ keep the name usable in SQL without quotes."}
              </span>
            )}
          </div>
        </DialogBody>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button disabled={!canDuplicate} onClick={() => void submit()}>
            {busy && <Loader2 className="spin h-4 w-4 text-text-3" />}
            Duplicate
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
