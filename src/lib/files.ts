import { useEffect, useState } from "react";
import { save, open } from "@tauri-apps/plugin-dialog";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { toast } from "sonner";
import {
  api,
  errMsg,
  type CopyProgress,
  type ImportOutcome,
  type ImportPreview,
  writeGuard,
} from "@/lib/api";

/** "documents" / "rows" for the active workspace's engine. */
const unitWord = (n?: number) => {
  const pg = writeGuard.engine() === "postgres";
  const one = pg ? "row" : "document";
  return n === 1 ? one : `${one}s`;
};

/** Run a cancellable job with a live progress toast (docs so far + cancel). */
async function withProgressToast(
  label: string,
  run: (jobId: string) => Promise<{ documents: number; canceled: boolean }>
): Promise<{ documents: number; canceled: boolean } | null> {
  const jobId = crypto.randomUUID();
  const toastId = toast.loading(`${label}...`, {
    action: { label: "Cancel", onClick: () => void api.cancelJob(jobId) },
  });
  let unlisten: UnlistenFn | null = null;
  const unit = unitWord();
  try {
    unlisten = await listen<CopyProgress>("copy-progress", (e) => {
      if (e.payload.jobId !== jobId) return;
      const total = e.payload.total ? ` / ${e.payload.total.toLocaleString()}` : "";
      toast.loading(`${label} - ${e.payload.copied.toLocaleString()}${total} ${unit}`, {
        id: toastId,
        action: { label: "Cancel", onClick: () => void api.cancelJob(jobId) },
      });
    });
    const outcome = await run(jobId);
    toast.dismiss(toastId);
    return outcome;
  } catch (e) {
    toast.dismiss(toastId);
    toast.error(errMsg(e));
    return null;
  } finally {
    unlisten?.();
  }
}

export type ExportFormat = "json" | "csv" | "ndjson" | "bson" | "xlsx" | "numbers";
export type SheetFormat = "xlsx" | "numbers";

/** Menu label, one-line hint and file dialog filter name per format. */
export const FORMAT_META: Record<ExportFormat, { label: string; hint: string; filter: string }> = {
  json: { label: "JSON", hint: "one array, pretty printed", filter: "JSON" },
  ndjson: { label: "NDJSON", hint: "one record per line", filter: "NDJSON" },
  csv: { label: "CSV", hint: "flat columns, any spreadsheet", filter: "CSV" },
  xlsx: { label: "Excel", hint: "typed cells, dates, frozen header", filter: "Excel workbook" },
  numbers: { label: "Numbers", hint: "converted by the Numbers app", filter: "Numbers document" },
  bson: { label: "BSON", hint: "mongodump-compatible archive", filter: "BSON" },
};

/** .numbers export needs Apple's Numbers app (macOS). Asked once, cached. */
let numbersOk = false;
let numbersAsked: Promise<boolean> | null = null;
export function checkNumbers(): Promise<boolean> {
  numbersAsked ??= api
    .numbersAvailable()
    .then((ok) => (numbersOk = ok))
    .catch(() => false);
  return numbersAsked;
}

/** React: whether .numbers export is offered (re-renders once known). */
export function useNumbersAvailable(): boolean {
  const [ok, setOk] = useState(numbersOk);
  useEffect(() => {
    let live = true;
    void checkNumbers().then((v) => live && setOk(v));
    return () => {
      live = false;
    };
  }, []);
  return ok;
}

/** Export formats the active workspace's engine can write (no BSON for
 *  PostgreSQL; Numbers only where the Numbers app is installed). */
export function exportFormats(): ExportFormat[] {
  const base: ExportFormat[] = ["json", "ndjson", "csv", "xlsx"];
  if (numbersOk) base.push("numbers");
  if (writeGuard.engine() !== "postgres") base.push("bson");
  return base;
}

const ROW_LIMIT_NOTE = (format: SheetFormat) =>
  format === "numbers" ? "Numbers holds 1,000,000 rows per table" : "Excel holds 1,048,576 rows per sheet";

/** Export matching documents to a known path - streamed, cancellable, with a
 *  progress toast. Returns the outcome (null on error). */
export async function runExport(args: {
  database: string;
  collection: string;
  filter: string;
  sort: string;
  format: ExportFormat;
  path: string;
}) {
  if (args.format === "numbers") await checkNumbers();
  if (!exportFormats().includes(args.format)) {
    toast.error(
      args.format === "numbers"
        ? "Numbers export needs Apple's Numbers app on this Mac - export Excel instead"
        : `${args.format.toUpperCase()} export isn't available for PostgreSQL - use JSON, NDJSON, CSV or Excel`
    );
    return null;
  }
  const outcome = await withProgressToast(
    args.format === "numbers" ? `Exporting ${args.collection} (Numbers converts at the end)` : `Exporting ${args.collection}`,
    (jobId) => api.exportCollection({ ...args, jobId })
  );
  if (!outcome) return null;
  if ((outcome as { truncated?: boolean }).truncated && (args.format === "xlsx" || args.format === "numbers")) {
    toast.warning(
      `Exported the first ${outcome.documents.toLocaleString()} ${unitWord(outcome.documents)} - ${ROW_LIMIT_NOTE(args.format)}. Use CSV or NDJSON for everything.`
    );
  } else if (outcome.canceled) {
    toast.info(`Export canceled - ${outcome.documents.toLocaleString()} ${unitWord(outcome.documents)} written`);
  } else {
    toast.success(`Exported ${outcome.documents.toLocaleString()} ${unitWord(outcome.documents)}`);
  }
  return outcome;
}

/** Prompt for a path and export matching documents. */
export async function exportCollection(args: {
  database: string;
  collection: string;
  filter: string;
  sort: string;
  format: ExportFormat;
}) {
  const ext = args.format;
  if (ext === "numbers") await checkNumbers();
  if (!exportFormats().includes(ext)) {
    toast.error(
      ext === "numbers"
        ? "Numbers export needs Apple's Numbers app on this Mac - export Excel instead"
        : `${ext.toUpperCase()} export isn't available for PostgreSQL - use JSON, NDJSON, CSV or Excel`
    );
    return;
  }
  const path = await save({
    title: `Export ${args.collection}`,
    defaultPath: `${args.collection}.${ext}`,
    filters: [{ name: FORMAT_META[ext].filter, extensions: [ext] }],
  }).catch(() => null);
  if (!path) return;
  await runExport({ ...args, path });
}

/** Prompt for a path and export saved connections. `includeSecrets` requires a
 *  passphrase and produces an encrypted bundle. Returns true on success. */
export async function exportConnections(args: {
  ids?: string[];
  includeSecrets: boolean;
  passphrase?: string;
}): Promise<boolean> {
  try {
    const name = args.includeSecrets ? "mongo-bongo-connections-encrypted.json" : "mongo-bongo-connections.json";
    const path = await save({
      title: "Export connections",
      defaultPath: name,
      filters: [{ name: "JSON", extensions: ["json"] }],
    });
    if (!path) return false;
    const count = await api.exportConnections({ ...args, path });
    toast.success(
      `Exported ${count} connection${count === 1 ? "" : "s"}${args.includeSecrets ? " (encrypted)" : " (no passwords)"}`
    );
    return true;
  } catch (e) {
    toast.error(errMsg(e));
    return false;
  }
}

/** Pick a connections export file and peek at it (encrypted? how many?). */
export async function pickConnectionImport(): Promise<{ path: string; preview: ImportPreview } | null> {
  try {
    const path = await open({
      title: "Import connections",
      multiple: false,
      filters: [{ name: "JSON", extensions: ["json"] }],
    });
    if (!path || typeof path !== "string") return null;
    const preview = await api.inspectConnectionImport(path);
    return { path, preview };
  } catch (e) {
    toast.error(errMsg(e));
    return null;
  }
}

/** Run the import for a previously-picked file. Returns the outcome, or null on error. */
export async function runConnectionImport(
  path: string,
  passphrase?: string
): Promise<ImportOutcome | null> {
  try {
    const outcome = await api.importConnections(path, passphrase);
    const tail =
      outcome.needsPassword > 0
        ? ` - set a password on ${outcome.needsPassword} of them`
        : "";
    toast.success(`Imported ${outcome.imported} connection${outcome.imported === 1 ? "" : "s"}${tail}`);
    return outcome;
  } catch (e) {
    toast.error(errMsg(e));
    return null;
  }
}

/** Prompt for a JSON/NDJSON/CSV/BSON file (no BSON for PostgreSQL) and import
 *  its documents / rows - streamed in batches, cancellable. Returns true when
 *  anything landed. */
export async function importDocuments(database: string, collection: string): Promise<boolean> {
  const pg = writeGuard.engine() === "postgres";
  const extensions = pg ? ["json", "ndjson", "jsonl", "csv"] : ["json", "ndjson", "jsonl", "csv", "bson"];
  const path = await open({
    title: `Import into ${collection}`,
    multiple: false,
    filters: [{ name: "Data files", extensions }],
  }).catch(() => null);
  if (!path || typeof path !== "string") return false;
  if (pg && /\.bson$/i.test(path)) {
    toast.error("BSON files can't be imported into PostgreSQL - use JSON, NDJSON or CSV");
    return false;
  }
  const outcome = await withProgressToast(`Importing into ${collection}`, (jobId) =>
    api.importDocuments(database, collection, path, jobId)
  );
  if (!outcome) return false;
  if (outcome.canceled) {
    toast.info(`Import canceled - ${outcome.documents.toLocaleString()} ${unitWord(outcome.documents)} inserted`);
  } else {
    toast.success(`Imported ${outcome.documents.toLocaleString()} ${unitWord(outcome.documents)}`);
  }
  return outcome.documents > 0;
}

/** Save rows the UI already holds (Studio results, overview tables) as a
 *  spreadsheet, after a save dialog. Returns true when a file was written. */
export async function saveRowsAsSheet(rows: Record<string, unknown>[], format: SheetFormat, name: string, title: string): Promise<boolean> {
  if (format === "numbers" && !(await checkNumbers())) {
    toast.error("Numbers export needs Apple's Numbers app on this Mac - export Excel instead");
    return false;
  }
  const path = await save({
    title,
    defaultPath: `${name}.${format}`,
    filters: [{ name: FORMAT_META[format].filter, extensions: [format] }],
  }).catch(() => null);
  if (!path) return false;
  const id = format === "numbers" ? toast.loading("Numbers is converting the export...") : undefined;
  try {
    const out = await api.saveSpreadsheet(path, format, rows, name);
    if (id !== undefined) toast.dismiss(id);
    if (out.truncated) toast.warning(`Exported the first ${out.rows.toLocaleString()} rows - ${ROW_LIMIT_NOTE(format)}`);
    else toast.success(`Exported ${out.rows.toLocaleString()} row${out.rows === 1 ? "" : "s"}`);
    return true;
  } catch (e) {
    if (id !== undefined) toast.dismiss(id);
    toast.error(errMsg(e));
    return false;
  }
}
