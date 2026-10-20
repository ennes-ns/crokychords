/**
 * MIDI/MusicXML import in the web app (docs/specs/import-v1.md §B): reading picked or dropped
 * files and running the core importer on them, one entry per file for the preview.
 */
import type { ImportOptions, ImportResult, Mode } from '@crokychords/core';
import { ImportError, importFile, isImportFileName } from '@crokychords/core';
import { readBytes } from './breakcore';

/** Most files one import takes (a folder may hold more; the rest are skipped). */
export const MAX_IMPORT_FILES = 200;
/** Largest file the importer reads. */
export const MAX_IMPORT_FILE_BYTES = 5 * 1024 * 1024;

export interface ImportSource {
  /** File name, with a folder path when it came from a folder. */
  name: string;
  bytes: Uint8Array;
}

/** One file of an import: its result or why it failed. */
export interface ImportEntry {
  source: ImportSource;
  result: ImportResult | null;
  error: string | null;
  /** The key the user chose in the preview, when it overrides the detected one. */
  key: { tonic: string; mode: Mode } | null;
}

/** Run the importer on one file; any failure becomes the entry's error, never an exception. */
export function importEntry(
  source: ImportSource,
  key: { tonic: string; mode: Mode } | null = null,
): ImportEntry {
  const options: ImportOptions = key === null ? {} : { key };
  try {
    return { source, result: importFile(source.name, source.bytes, options), error: null, key };
  } catch (e) {
    const message =
      e instanceof ImportError
        ? e.message
        : `the importer failed: ${e instanceof Error ? e.message : String(e)}`;
    return { source, result: null, error: message, key };
  }
}

/** The importable files of a picked or dropped list, and what was left out. */
export function importableFiles<T extends { name: string; size: number }>(
  files: readonly T[],
): { files: T[]; skipped: string[] } {
  const out: T[] = [];
  const skipped: string[] = [];
  for (const file of files) {
    if (!isImportFileName(file.name)) continue;
    if (file.size > MAX_IMPORT_FILE_BYTES) skipped.push(`${file.name} (larger than 5 MB)`);
    else if (out.length >= MAX_IMPORT_FILES)
      skipped.push(`${file.name} (over ${MAX_IMPORT_FILES} files)`);
    else out.push(file);
  }
  return { files: out, skipped };
}

/** The path of a file inside a picked folder, else its name. */
export function fileLabel(file: File): string {
  return file.webkitRelativePath || file.name;
}

/** Read files into import sources. */
export async function readSources(files: readonly File[]): Promise<ImportSource[]> {
  return Promise.all(
    files.map(async (file) => ({
      name: fileLabel(file),
      bytes: new Uint8Array(await readBytes(file)),
    })),
  );
}

/** Most directory levels a dropped folder is walked into. */
const MAX_DROP_DEPTH = 8;

function entryFile(entry: FileSystemFileEntry): Promise<File | null> {
  return new Promise((resolve) => entry.file(resolve, () => resolve(null)));
}

function readEntries(reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> {
  return new Promise((resolve) => reader.readEntries(resolve, () => resolve([])));
}

async function walk(entry: FileSystemEntry, depth: number, out: File[]): Promise<void> {
  if (out.length >= MAX_IMPORT_FILES * 4) return;
  if (entry.isFile) {
    const file = await entryFile(entry as FileSystemFileEntry);
    if (file !== null) out.push(file);
    return;
  }
  if (!entry.isDirectory || depth >= MAX_DROP_DEPTH) return;
  const reader = (entry as FileSystemDirectoryEntry).createReader();
  // readEntries returns the entries in batches until an empty one.
  for (;;) {
    const batch = await readEntries(reader);
    if (batch.length === 0) break;
    for (const child of batch) await walk(child, depth + 1, out);
  }
}

/** The files of a drop, walking dropped folders where the browser allows it. */
export async function droppedFiles(transfer: DataTransfer): Promise<File[]> {
  const entries: FileSystemEntry[] = [];
  for (const item of Array.from(transfer.items)) {
    const entry = item.kind === 'file' ? item.webkitGetAsEntry?.() : null;
    if (entry !== null && entry !== undefined) entries.push(entry);
  }
  if (entries.length === 0 || entries.every((e) => e.isFile)) return Array.from(transfer.files);
  const out: File[] = [];
  for (const entry of entries) await walk(entry, 0, out);
  return out;
}

/** True while a drag carries files. */
export function dragHasFiles(transfer: DataTransfer | null): boolean {
  return transfer !== null && Array.from(transfer.types).includes('Files');
}
