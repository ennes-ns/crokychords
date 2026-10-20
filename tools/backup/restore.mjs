#!/usr/bin/env node
// Restore one D1 table or one user's saves from a weekly backup set (docs/specs/backups-v1.md §8).
// Dry-run by default: downloads what it needs, writes the SQL and prints what --apply would do.
//
//   node tools/backup/restore.mjs --set 2026-10-26 --table saves [--wipe] [--apply]
//   node tools/backup/restore.mjs --set 2026-10-26 --user <user-id> [--apply]
//
// Options: --from-dir <dir> reads a set already downloaded (the directory that holds d1/ and r2/)
// instead of calling `wrangler r2 object get`; --local targets the local wrangler dev storage
// instead of production (for a rehearsal). Wrangler runs from apps/api, so its login and
// wrangler.toml apply. The temporary directory holds personal data: the script prints it; delete
// it when done.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Buffer } from 'node:buffer';

const BACKUP_BUCKET = 'crokychords-backups';
const SAVES_BUCKET = 'crokychords-saves';
const DATABASE = 'crokychords';
const API_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../apps/api');

const USAGE = `usage: restore.mjs --set YYYY-MM-DD (--table <name> [--wipe] | --user <user-id>)
                   [--apply] [--from-dir <dir>] [--local]`;

function parseArgs(argv) {
  const opts = { apply: false, wipe: false, local: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined) fail(`${arg} needs a value`);
      return v;
    };
    if (arg === '--set') opts.set = value();
    else if (arg === '--table') opts.table = value();
    else if (arg === '--user') opts.user = value();
    else if (arg === '--from-dir') opts.fromDir = resolve(value());
    else if (arg === '--apply') opts.apply = true;
    else if (arg === '--wipe') opts.wipe = true;
    else if (arg === '--local') opts.local = true;
    else if (arg === '--help' || arg === '-h') {
      console.log(USAGE);
      process.exit(0);
    } else fail(`unknown option ${arg}`);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(opts.set ?? '')) fail('--set YYYY-MM-DD is required');
  if ((opts.table === undefined) === (opts.user === undefined)) {
    fail('give exactly one of --table or --user');
  }
  if (opts.table !== undefined && !/^[A-Za-z0-9_]+$/.test(opts.table)) fail('bad table name');
  if (opts.user !== undefined && !/^[A-Za-z0-9_-]{1,64}$/.test(opts.user)) fail('bad user id');
  if (opts.wipe && opts.table === undefined) fail('--wipe only goes with --table');
  return opts;
}

function fail(message) {
  console.error(`restore: ${message}\n${USAGE}`);
  process.exit(2);
}

function wrangler(args, opts) {
  const target = opts.local ? '--local' : '--remote';
  execFileSync('pnpm', ['exec', 'wrangler', ...args, target], { cwd: API_DIR, stdio: 'inherit' });
}

/** A file of the set (path relative to the set prefix), downloaded once into `work`. */
function fetchFile(rel, opts, work) {
  if (opts.fromDir !== undefined) {
    const file = join(opts.fromDir, rel);
    return existsSync(file) ? file : null;
  }
  const file = join(work, rel);
  if (existsSync(file)) return file;
  mkdirSync(dirname(file), { recursive: true });
  try {
    wrangler(
      ['r2', 'object', 'get', `${BACKUP_BUCKET}/weekly/${opts.set}/${rel}`, '--file', file],
      opts,
    );
  } catch {
    return null;
  }
  return existsSync(file) ? file : null;
}

function readRows(file) {
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line));
}

function ident(name) {
  return `"${String(name).replaceAll('"', '""')}"`;
}

/** A JSON-lines value as an SQL literal (BLOBs were written as {"$base64": "…"}). */
function literal(value) {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('non-finite number in backup');
    return String(value);
  }
  if (typeof value === 'boolean') return value ? '1' : '0';
  if (typeof value === 'string') return `'${value.replaceAll("'", "''")}'`;
  if (typeof value === 'object' && typeof value.$base64 === 'string') {
    return `X'${Buffer.from(value.$base64, 'base64').toString('hex')}'`;
  }
  throw new Error(`unsupported value in backup: ${typeof value}`);
}

/**
 * Upserts that keep the row in place (ON CONFLICT DO UPDATE, not INSERT OR REPLACE: a REPLACE
 * deletes the old row first, and deleting a user cascades to their saves).
 */
function upserts(table, rows) {
  return rows.map((row) => {
    const cols = Object.keys(row);
    const set = cols.map((c) => `${ident(c)} = excluded.${ident(c)}`).join(', ');
    return (
      `INSERT INTO ${ident(table)} (${cols.map(ident).join(', ')}) ` +
      `VALUES (${cols.map((c) => literal(row[c])).join(', ')}) ON CONFLICT DO UPDATE SET ${set};`
    );
  });
}

function writeSql(work, name, statements) {
  const file = join(work, name);
  writeFileSync(file, `${statements.join('\n')}\n`);
  return file;
}

function restoreTable(opts, work) {
  const file = fetchFile(`d1/${opts.table}.jsonl`, opts, work);
  if (file === null) fail(`set ${opts.set} has no table ${opts.table}`);
  const rows = readRows(file);
  const statements = [...(opts.wipe ? [`DELETE FROM ${ident(opts.table)};`] : [])];
  statements.push(...upserts(opts.table, rows));
  const sql = writeSql(work, `restore-${opts.table}.sql`, statements);
  console.log(`table ${opts.table}: ${rows.length} rows from set ${opts.set}`);
  if (opts.wipe) console.log(`--wipe: deletes every current row of ${opts.table} first`);
  console.log(`SQL: ${sql}`);
  if (!opts.apply) {
    console.log(`dry run; with --apply: wrangler d1 execute ${DATABASE} --file ${sql}`);
    return;
  }
  wrangler(['d1', 'execute', DATABASE, '--file', sql, '--yes'], opts);
}

function restoreUser(opts, work) {
  const usersFile = fetchFile('d1/users.jsonl', opts, work);
  const savesFile = fetchFile('d1/saves.jsonl', opts, work);
  if (usersFile === null || savesFile === null) fail(`set ${opts.set} lacks users or saves`);
  const user = readRows(usersFile).filter((r) => r.id === opts.user);
  if (user.length === 0) fail(`user ${opts.user} is not in set ${opts.set}`);
  const saves = readRows(savesFile).filter((r) => r.user_id === opts.user);
  const bodies = [];
  for (const save of saves) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(String(save.id))) fail('bad save id in backup');
    const key = `saves/${opts.user}/${save.id}.json`;
    const file = fetchFile(`r2/${key}`, opts, work);
    if (file === null) console.warn(`warning: no body for ${key} in the set; row restored anyway`);
    else bodies.push({ key, file });
  }
  const sql = writeSql(work, `restore-user-${opts.user}.sql`, [
    ...upserts('users', user),
    ...upserts('saves', saves),
  ]);
  console.log(
    `user ${opts.user}: ${saves.length} save rows, ${bodies.length} bodies from set ${opts.set}`,
  );
  console.log(`SQL: ${sql}`);
  if (!opts.apply) {
    console.log('dry run; with --apply: the SQL above, then for every body:');
    for (const b of bodies) console.log(`  wrangler r2 object put ${SAVES_BUCKET}/${b.key}`);
    return;
  }
  wrangler(['d1', 'execute', DATABASE, '--file', sql, '--yes'], opts);
  for (const b of bodies) {
    wrangler(
      [
        'r2',
        'object',
        'put',
        `${SAVES_BUCKET}/${b.key}`,
        '--file',
        b.file,
        '--content-type',
        'application/json',
      ],
      opts,
    );
  }
}

const opts = parseArgs(process.argv.slice(2));
const work = mkdtempSync(join(tmpdir(), `crokychords-restore-${opts.set}-`));
console.log(`working directory (holds personal data, delete when done): ${work}`);
if (opts.table !== undefined) restoreTable(opts, work);
else restoreUser(opts, work);
console.log(opts.apply ? 'restored.' : 'nothing changed (dry run).');
