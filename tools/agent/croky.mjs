#!/usr/bin/env node
// Drive the Croky Chords web app headlessly through `window.croky` (docs/howto/agents.md,
// docs/specs/assistant-v1.md §A6). Starts the Vite dev server on a random port and a muted
// headless Chromium on a random debugging port above 9400, then either runs the integration
// scenario (--check) or a JSON file of commands (--run FILE).
//
//   node tools/agent/croky.mjs --check [--out song.mid]
//   node tools/agent/croky.mjs --run commands.json [--out song.mid] [--url http://127.0.0.1:5173/]
import { Buffer } from 'node:buffer';
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { launchChromium, randomPort, waitForHttp } from './cdp.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const WEB = join(ROOT, 'apps', 'web');

const USAGE = `croky.mjs --check | --run FILE   [--out FILE.mid] [--url URL]

  --check      integration scenario: build I-V-vi-IV through window.croky, add a melody,
               play and stop (muted), undo/redo, export a .mid and check it
  --run FILE   apply the commands in FILE (a command, an array, or { "commands", "undo" })
               and print the result and the song as JSON
  --out FILE   write the exported .mid there
  --url URL    use an app that is already running instead of starting the dev server`;

function parseArgs(argv) {
  const args = { check: false, run: null, out: null, url: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === '--check') args.check = true;
    else if (a === '--run') args.run = value();
    else if (a === '--out') args.out = value();
    else if (a === '--url') args.url = value();
    else if (a === '-h' || a === '--help') throw new Error(USAGE);
    else throw new Error(`unknown argument ${a}\n\n${USAGE}`);
  }
  if (args.check === (args.run !== null)) throw new Error(USAGE);
  return args;
}

/**
 * Start `vite` for apps/web on a random port; resolves to `{ url, close() }`. `extraEnv` is passed
 * to Vite (the check sets `VITE_ASSISTANT=on` so the hidden-by-default panel is exercised).
 */
async function startVite(extraEnv = {}) {
  const port = await randomPort(20000, 40000);
  const vite = join(WEB, 'node_modules', 'vite', 'bin', 'vite.js');
  const child = spawn(
    process.execPath,
    [vite, '--port', String(port), '--strictPort', '--host', '127.0.0.1', '--clearScreen', 'false'],
    {
      cwd: WEB,
      stdio: ['ignore', 'ignore', 'pipe'],
      env: { ...process.env, ...extraEnv, BROWSER: 'none' },
    },
  );
  let stderr = '';
  child.stderr.on('data', (d) => (stderr = (stderr + d).slice(-4000)));
  const url = `http://127.0.0.1:${port}/`;
  try {
    await waitForHttp(url, 60_000);
  } catch (e) {
    child.kill('SIGKILL');
    throw new Error(`the dev server did not start: ${e.message}\n${stderr}`);
  }
  return {
    url,
    close: () => child.kill('SIGTERM'),
  };
}

/** Open the app and wait until `window.croky` is there. */
async function openApp(browser, url) {
  const page = await browser.newPage('about:blank');
  const exceptions = [];
  page.on('Runtime.exceptionThrown', (p) =>
    exceptions.push(p.exceptionDetails?.exception?.description ?? p.exceptionDetails?.text),
  );
  await page.send('Runtime.enable');
  await page.send('Page.enable');
  await page.send('Page.navigate', { url });
  const until = Date.now() + 30_000;
  while (Date.now() < until) {
    const ready = await page.evaluate('typeof window.croky === "object"').catch(() => false);
    if (ready) return { page, exceptions };
    await sleep(200);
  }
  throw new Error(`window.croky did not appear at ${url}`);
}

/** Run commands in the page; `options` is passed to applyCommands. */
function apply(page, commands, options = {}) {
  return page.evaluate(
    `window.croky.applyCommands(${JSON.stringify(commands)}, ${JSON.stringify(options)})`,
  );
}

function check(condition, message) {
  if (!condition) throw new Error(`check failed: ${message}`);
  console.log(`ok - ${message}`);
}

/** Minimal SMF reader: format, track count and the track names. */
export function readSmf(bytes) {
  const text = (at, n) => String.fromCharCode(...bytes.subarray(at, at + n));
  const u32 = (at) =>
    (bytes[at] << 24) | (bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3];
  if (text(0, 4) !== 'MThd') throw new Error('not a MIDI file');
  const format = (bytes[8] << 8) | bytes[9];
  const tracks = (bytes[10] << 8) | bytes[11];
  const names = [];
  let at = 8 + u32(4);
  for (let t = 0; t < tracks; t++) {
    if (text(at, 4) !== 'MTrk') throw new Error(`track ${t} has no MTrk header`);
    const length = u32(at + 4);
    const body = bytes.subarray(at + 8, at + 8 + length);
    for (let i = 0; i + 3 < body.length; i++) {
      if (body[i] === 0xff && body[i + 1] === 0x03) {
        names.push(String.fromCharCode(...body.subarray(i + 3, i + 3 + body[i + 2])));
        break;
      }
    }
    at += 8 + length;
  }
  return { format, tracks, names };
}

async function exportMidi(page, out) {
  const result = await apply(page, { op: 'exportMidi' });
  if (!result.ok) throw new Error(`exportMidi failed: ${JSON.stringify(result.error)}`);
  const { fileName, base64 } = result.results[0];
  const bytes = new Uint8Array(Buffer.from(base64, 'base64'));
  if (out !== null) writeFileSync(out, bytes);
  return { fileName, bytes };
}

async function runCheck(page, out, expectAssistant) {
  const fresh = await apply(page, [{ op: 'newSong' }, { op: 'setTitle', title: 'Agent check' }]);
  check(fresh.ok, 'a new song');

  const built = await apply(page, [
    { op: 'appendChord', token: 'I' },
    { op: 'appendChord', token: 'V' },
    { op: 'appendChord', token: 'vi' },
    { op: 'appendChord', token: 'IV' },
  ]);
  check(built.ok && built.applied === 4, 'four chords applied');
  let song = await page.evaluate('window.croky.getSong()');
  check(
    JSON.stringify(song.chords.map((c) => c.token)) === '["I","V","vi","IV"]',
    'the progression is I–V–vi–IV',
  );

  const melody = await apply(page, [
    { op: 'addNote', beat: 0, length: 2, degree: 3 },
    { op: 'addNote', beat: 2, length: 2, degree: 2 },
    { op: 'addNote', beat: 4, length: 4, degree: 2 },
    { op: 'addNote', beat: 8, length: 4, degree: 1 },
    { op: 'addNote', beat: 12, length: 4, degree: 6, octave: -1 },
  ]);
  check(melody.ok, 'a five-note melody added');

  const bad = await apply(page, [
    { op: 'appendChord', token: 'ii' },
    { op: 'replaceChord', index: 40, token: 'V' },
  ]);
  check(
    !bad.ok && bad.applied === 0 && bad.error.code === 'not_found',
    'a bad batch changes nothing',
  );

  const next = await page.evaluate('window.croky.suggestions({ limit: 3 })');
  check(
    next.items.length === 3,
    `suggestions after the song: ${next.items.map((i) => i.token).join(' ')}`,
  );

  const played = await apply(page, [{ op: 'play' }]);
  check(played.ok, 'playback starts (muted)');
  await sleep(400);
  const playing = await page.evaluate('window.croky.getState()');
  check(playing.playing === true, 'the app reports playing');
  check((await apply(page, [{ op: 'stop' }])).ok, 'playback stops');

  await apply(page, { op: 'undo' });
  song = await page.evaluate('window.croky.getSong()');
  check(song.melody.notes.length === 4, 'undo removes the last note');
  await apply(page, { op: 'redo' });
  song = await page.evaluate('window.croky.getSong()');
  check(song.melody.notes.length === 5, 'redo brings it back');

  const { fileName, bytes } = await exportMidi(page, out);
  const smf = readSmf(bytes);
  check(fileName === 'Agent check.mid', `exported ${fileName} (${bytes.length} bytes)`);
  // Conductor, the unmuted band tracks (Chords, Bass; the Arp is muted) and the melody.
  check(smf.format === 1 && smf.tracks === 4, `format ${smf.format}, ${smf.tracks} tracks`);
  check(smf.names.includes('Melody'), `track names: ${smf.names.join(', ')}`);

  // MIDI/MusicXML import (docs/specs/import-v1.md §C): the export comes back as the same song.
  const data = Buffer.from(bytes).toString('base64');
  const imported = await apply(page, { op: 'importFile', name: fileName, data });
  check(imported.ok && imported.results[0].chords === 4, 'importFile reads the export back');
  const back = await page.evaluate('window.croky.getSong()');
  check(
    JSON.stringify(back.chords) === JSON.stringify(song.chords) &&
      JSON.stringify(back.melody.notes) === JSON.stringify(song.melody.notes),
    `the import has the same chords and melody (${imported.results[0].key})`,
  );

  // The assistant is hidden unless enabled (issue #100); on a server we started it must be on.
  const panel = await page.evaluate(`(async () => {
    const toggle = document.querySelector('.assistant-toggle');
    if (toggle === null || toggle.hidden) return null;
    toggle.click();
    await new Promise((r) => setTimeout(r, 100));
    const status = document.querySelector('.assistant-status').textContent;
    document.querySelector('.assistant-toggle').click();
    return status;
  })()`);
  if (panel === null && !expectAssistant) {
    check(true, 'assistant panel: hidden (not enabled on this server)');
  } else {
    check(typeof panel === 'string' && panel.length > 0, `assistant panel: ${panel}`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const server =
    args.url === null ? await startVite(args.check ? { VITE_ASSISTANT: 'on' } : {}) : null;
  const browser = await launchChromium();
  try {
    const { page, exceptions } = await openApp(browser, args.url ?? server.url);
    if (args.check) {
      await runCheck(page, args.out, server !== null);
      check(
        exceptions.length === 0,
        `no uncaught page errors${exceptions.length ? `: ${exceptions.join('; ')}` : ''}`,
      );
    } else {
      const input = JSON.parse(readFileSync(args.run, 'utf8'));
      const wrapped = input !== null && typeof input === 'object' && 'commands' in input;
      const commands = wrapped ? input.commands : input;
      const options = wrapped && input.undo !== undefined ? { undo: input.undo } : {};
      const result = await apply(page, commands, options);
      const song = await page.evaluate('window.croky.getSong()');
      if (args.out !== null) await exportMidi(page, args.out);
      console.log(JSON.stringify({ result, song }, null, 2));
      if (!result.ok) process.exitCode = 1;
    }
    page.close();
  } finally {
    await browser.close();
    server?.close();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
