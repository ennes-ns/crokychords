#!/usr/bin/env node
/**
 * Fetch the SoundFont samples the web app ships (docs/specs/soundfonts-v1.md §3).
 *
 *   node tools/soundfonts/fetch.mjs                  fetch what is missing, verify everything
 *   node tools/soundfonts/fetch.mjs --check          verify only, no network (exit 1 on problems)
 *   node tools/soundfonts/fetch.mjs --if-missing     skip when every file exists; warn offline
 *   node tools/soundfonts/fetch.mjs --write-manifest recompute manifest.json (maintainer only)
 *
 * Options: --out <dir> (default apps/web/public/soundfonts), --downloads <dir> (keep the source
 * files there; must be new or empty, default a fresh temporary directory).
 *
 * Every downloaded file is checked against the SHA-256 in manifest.json before anything is
 * written; the source JavaScript is read as text by a strict parser, never evaluated.
 */
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { noteGrid, noteName, noticeText, parseSoundfontJs } from './lib.mjs';

const here = fileURLToPath(new URL('.', import.meta.url));
const MANIFEST = join(here, 'manifest.json');
const DEFAULT_OUT = join(here, '../../apps/web/public/soundfonts');
const ATTEMPTS = 3;
const TIMEOUT_MS = 60_000;

function parseArgs(argv) {
  const opts = { check: false, ifMissing: false, writeManifest: false, out: DEFAULT_OUT };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--check') opts.check = true;
    else if (arg === '--if-missing') opts.ifMissing = true;
    else if (arg === '--write-manifest') opts.writeManifest = true;
    else if (arg === '--out' || arg === '--downloads') {
      const value = argv[++i];
      if (value === undefined) throw new Error(`${arg} needs a directory`);
      opts[arg === '--out' ? 'out' : 'downloads'] = value;
    } else throw new Error(`unknown argument: ${arg}`);
  }
  return opts;
}

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

function readManifest() {
  const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));
  if (manifest.schema_version !== 1) {
    throw new Error(`manifest.json: unsupported schema_version ${manifest.schema_version}`);
  }
  if (!/^[0-9a-f]{40}$/.test(manifest.source.commit)) throw new Error('manifest: bad commit');
  return manifest;
}

function rawUrl(manifest, path) {
  const repo = manifest.source.repository.replace(/^https:\/\/github\.com\//, '');
  return `https://raw.githubusercontent.com/${repo}/${manifest.source.commit}/${path}`;
}

async function download(url) {
  let last;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return new Uint8Array(await response.arrayBuffer());
    } catch (e) {
      last = e;
    }
  }
  throw new Error(`could not download ${url}: ${last instanceof Error ? last.message : last}`);
}

/** A fresh directory for the downloads: the given one (new or empty) or a temporary one. */
function downloadsDir(dir) {
  if (dir === undefined) return mkdtempSync(join(tmpdir(), 'crokychords-soundfonts-'));
  mkdirSync(dir, { recursive: true });
  if (readdirSync(dir).length > 0) throw new Error(`--downloads ${dir} is not empty`);
  return dir;
}

/** Download `path` of the source repository into `dir`, verify it against `entry` when given. */
async function fetchSource(manifest, path, dir, entry) {
  const bytes = await download(rawUrl(manifest, path));
  if (entry !== undefined && (sha256(bytes) !== entry.sha256 || bytes.length !== entry.bytes)) {
    throw new Error(`${path}: checksum mismatch (expected ${entry.sha256})`);
  }
  writeFileSync(join(dir, path.split('/').at(-1)), bytes);
  return bytes;
}

function fileOk(path, entry) {
  if (!existsSync(path)) return false;
  const bytes = readFileSync(path);
  return bytes.length === entry.bytes && sha256(bytes) === entry.sha256;
}

/** Problems of one instrument's folder (missing, wrong or stray files). */
function instrumentProblems(out, instrument) {
  const dir = join(out, instrument.name);
  const problems = [];
  for (const [note, entry] of Object.entries(instrument.notes)) {
    if (!fileOk(join(dir, `${note}.ogg`), entry)) problems.push(`${instrument.name}/${note}.ogg`);
  }
  if (existsSync(dir)) {
    for (const file of readdirSync(dir)) {
      if (!(file.replace(/\.ogg$/, '') in instrument.notes)) {
        problems.push(`${instrument.name}/${file} (not in the manifest)`);
      }
    }
  }
  return problems;
}

function sharedProblems(out, manifest) {
  const problems = [];
  if (!fileOk(join(out, 'LICENSE.txt'), manifest.source.licence)) problems.push('LICENSE.txt');
  const notice = join(out, 'NOTICE.txt');
  if (!existsSync(notice) || readFileSync(notice, 'utf8') !== noticeText(manifest)) {
    problems.push('NOTICE.txt');
  }
  return problems;
}

/** The notes of `instrument` from its parsed source, checked against the manifest. */
function extract(instrument, parsed) {
  const files = new Map();
  for (const [note, entry] of Object.entries(instrument.notes)) {
    const bytes = parsed.get(note);
    if (bytes === undefined) throw new Error(`${instrument.name}: ${note} missing in the source`);
    if (sha256(bytes) !== entry.sha256 || bytes.length !== entry.bytes) {
      throw new Error(`${instrument.name}/${note}.ogg: checksum mismatch`);
    }
    files.set(note, bytes);
  }
  return files;
}

function shippedBytes(manifest) {
  return manifest.instruments.reduce(
    (sum, i) => sum + Object.values(i.notes).reduce((s, n) => s + n.bytes, 0),
    0,
  );
}

const mb = (bytes) => `${(bytes / 1_000_000).toFixed(2)} MB`;

async function fetchAll(opts, manifest) {
  const { out } = opts;
  let dir = null;
  const dirFor = () => (dir ??= downloadsDir(opts.downloads));
  mkdirSync(out, { recursive: true });

  if (!fileOk(join(out, 'LICENSE.txt'), manifest.source.licence)) {
    const { file } = manifest.source.licence;
    const bytes = await fetchSource(manifest, file, dirFor(), manifest.source.licence);
    writeFileSync(join(out, 'LICENSE.txt'), bytes);
  }
  writeFileSync(join(out, 'NOTICE.txt'), noticeText(manifest));

  let fetched = 0;
  for (const instrument of manifest.instruments) {
    if (instrumentProblems(out, instrument).length === 0) continue;
    const path = `${manifest.source.folder}/${instrument.source.file}`;
    const bytes = await fetchSource(manifest, path, dirFor(), instrument.source);
    const files = extract(
      instrument,
      parseSoundfontJs(new TextDecoder().decode(bytes), instrument.name),
    );
    const target = join(out, instrument.name);
    rmSync(target, { recursive: true, force: true });
    mkdirSync(target, { recursive: true });
    for (const [note, data] of files) writeFileSync(join(target, `${note}.ogg`), data);
    fetched += 1;
    console.log(`soundfonts: ${instrument.name} (${files.size} notes)`);
  }
  for (const entry of readdirSync(out)) {
    const known = ['LICENSE.txt', 'NOTICE.txt', ...manifest.instruments.map((i) => i.name)];
    if (!known.includes(entry)) rmSync(join(out, entry), { recursive: true, force: true });
  }
  if (dir !== null && opts.downloads === undefined) rmSync(dir, { recursive: true, force: true });
  const total = shippedBytes(manifest);
  console.log(
    `soundfonts: ${manifest.instruments.length} instruments ready (${fetched} fetched), ${mb(total)}`,
  );
}

async function writeManifest(opts, manifest) {
  const dir = downloadsDir(opts.downloads);
  const licence = await fetchSource(manifest, manifest.source.licence.file, dir);
  manifest.source.licence.sha256 = sha256(licence);
  manifest.source.licence.bytes = licence.length;
  for (const instrument of manifest.instruments) {
    const file = `${instrument.name}-ogg.js`;
    const bytes = await fetchSource(manifest, `${manifest.source.folder}/${file}`, dir);
    instrument.source = { file, sha256: sha256(bytes), bytes: bytes.length };
    const parsed = parseSoundfontJs(new TextDecoder().decode(bytes), instrument.name);
    instrument.notes = {};
    for (const midi of noteGrid(manifest.notes, instrument.top)) {
      const note = noteName(midi);
      const data = parsed.get(note);
      if (data === undefined) throw new Error(`${instrument.name}: ${note} missing in the source`);
      instrument.notes[note] = { sha256: sha256(data), bytes: data.length };
    }
    console.log(`manifest: ${instrument.name} (${Object.keys(instrument.notes).length} notes)`);
  }
  writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`manifest: written, ${mb(shippedBytes(manifest))} shipped; downloads in ${dir}`);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const manifest = readManifest();
  if (opts.writeManifest) return writeManifest(opts, manifest);
  if (opts.check) {
    const problems = [
      ...sharedProblems(opts.out, manifest),
      ...manifest.instruments.flatMap((i) => instrumentProblems(opts.out, i)),
    ];
    for (const p of problems) console.error(`soundfonts: missing or wrong: ${p}`);
    if (problems.length > 0) process.exit(1);
    console.log(`soundfonts: all ${manifest.instruments.length} instruments verified`);
    return;
  }
  // Cheap completeness test (no hashing) so `pnpm dev` starts fast; a broken file still needs a
  // plain run or --check.
  const complete = manifest.instruments.every((i) =>
    Object.keys(i.notes).every((note) => existsSync(join(opts.out, i.name, `${note}.ogg`))),
  );
  if (opts.ifMissing && complete) return;
  try {
    await fetchAll(opts, manifest);
  } catch (e) {
    if (!opts.ifMissing) throw e;
    console.warn(`soundfonts: ${e instanceof Error ? e.message : e}`);
    console.warn('soundfonts: continuing without samples; the app plays its synth stand-ins.');
  }
}

main().catch((e) => {
  console.error(`soundfonts: ${e instanceof Error ? e.message : e}`);
  process.exit(1);
});
