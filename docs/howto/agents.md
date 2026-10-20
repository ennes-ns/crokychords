# How an agent works on a song

Croky Chords has one machine-readable control surface: **JSON commands**
([`docs/specs/assistant-v1.md`](../specs/assistant-v1.md) §A). The same commands work in the web
app (`window.croky`) and in the terminal app (`croky-tui --commands`), and the in-app assistant
answers with them too. This page shows the three ways to use them without a mouse.

**One rule for every run: never play sound on the host.** The web app is only ever driven by a
headless Chromium started with `--mute-audio` (the scripts below do this for you); the terminal
app only sends MIDI to a port you choose.

## The commands in one minute

A command is a JSON object with an `op`:

```json
[
  { "op": "setKey", "tonic": "A", "mode": "minor" },
  { "op": "setChords", "chords": [{ "token": "i", "beats": 4 }, { "token": "bVI", "beats": 4 }] },
  { "op": "appendChord", "token": "bVII" },
  { "op": "addNote", "beat": 0, "length": 2, "degree": 3 },
  { "op": "setTrackPattern", "track": 1, "preset": "bass-root-fifth" },
  { "op": "exportMidi" }
]
```

- Chords are Roman-numeral tokens relative to the key (`I`, `vi`, `V7/vi`, `bVII`, `ii7/1`,
  `rest`); see the grammar in [`packages/data/README.md`](../../packages/data/README.md).
- Indices are 0-based; beats are quarter notes on a ¼-beat grid; MIDI channels are 0–15.
- The full list with arguments: spec §A2, or `commands()` at run time (summaries, kinds, an
  example per op and the JSON schema).
- A `.mid` or uncompressed MusicXML file comes in with
  `{ "op": "importFile", "name": "song.mid", "data": "<base64>" }` (web app only): the song is
  replaced (one undo step) and the result carries the import report (key, chords, what was
  dropped); add `"tonic"` and `"mode"` to choose the key instead of detecting it.
- A batch is checked completely before anything changes (`ok: false, applied: 0` and an error
  with `code`, `index` of the command, `path` of the field and a `message`). Every song edit is
  one undo step; pass `{ undo: 'batch' }` to make the whole batch one.

Results look like this:

```json
{ "ok": true, "applied": 2, "results": [{ "op": "appendChord", "changed": true, "index": 4 }, { "op": "exportMidi", "fileName": "Untitled.mid", "bytes": 444, "base64": "TVRoZ..." }] }
```

## 1. The script: `tools/agent/croky.mjs`

The quickest way. It starts the Vite dev server on a random port and a muted headless Chromium
on a random debugging port above 9400 with a throwaway profile, opens the app, runs, and cleans
up. It needs Node 22 (for the built-in `WebSocket`) and a Chromium (`CHROME_PATH` to pick one).

```bash
# apply a file of commands; prints { result, song } as JSON; --out writes the .mid
node tools/agent/croky.mjs --run my-commands.json --out song.mid

# the integration check CI runs: I–V–vi–IV, a melody, play/stop (muted), undo/redo, .mid export
# and its re-import
pnpm agent:check
```

The file holds one command, an array, or `{ "commands": [...], "undo": "batch" }`.

## 2. Your own CDP session: `window.croky`

When you need more than one round trip (read the song, decide, change it, read again), drive the
page yourself. `tools/agent/cdp.mjs` has the pieces (`launchChromium`, `newPage`, `evaluate`):

```js
import { launchChromium } from './tools/agent/cdp.mjs';

const browser = await launchChromium(); // --headless=new --mute-audio, port 9401–9998
const page = await browser.newPage();
await page.send('Page.enable');
await page.send('Page.navigate', { url: 'http://127.0.0.1:5173/' }); // a running `pnpm dev`
// Wait for the API (the page fires `croky:ready` on document when it is set).
while (!(await page.evaluate('typeof window.croky === "object"'))) await new Promise((r) => setTimeout(r, 200));

const song = await page.evaluate('window.croky.getSong()');
const next = await page.evaluate('window.croky.suggestions({ limit: 5 })');
const result = await page.evaluate(
  `window.croky.applyCommands(${JSON.stringify([{ op: 'appendChord', token: next.items[0].token }])})`,
);
await browser.close();
```

What `window.croky` offers:

| Member | Returns |
| ------ | ------- |
| `getSong()` | The song as the app stores it (schema 4 JSON). |
| `getState()` | Selection, playing, cursor, loop, `canUndo`/`canRedo`, the suggestion table's status. |
| `suggestions({ at, limit, popular, diatonicOnly })` | The Next chord list for a slot. |
| `commands()` | The command list and JSON schema. |
| `applyCommands(commands, { undo })` | `Promise<ApplyResult>`. |
| `exportMidi()` | The `.mid` as a `Uint8Array` (over CDP use the `exportMidi` command's `base64`). |

All values are plain JSON, so `Runtime.evaluate` with `returnByValue: true` carries them as they
are. Use `--autoplay-policy=no-user-gesture-required` (already in the script's flags) if you want
`play` to work without a click; the audio still goes nowhere because of `--mute-audio`.

If you start Chromium yourself: always `--headless=new --mute-audio`, a random
`--remote-debugging-port` above 9400, a fresh `--user-data-dir`, and a random port for the dev
server (`node apps/web/node_modules/vite/bin/vite.js --port <random> --strictPort`). Never attach
to a browser someone is using.

## 3. The terminal app: `croky-tui --commands`

No browser at all: the terminal app reads one JSON-RPC 2.0 request per line on stdin and answers
on stdout. Without `--song` it works on its saved records (and saves after every change); with
`--song FILE` it edits that file and writes it on `save`.

```bash
cargo run --release -p croky-tui -- --commands --song /tmp/song.json <<'EOF'
{"jsonrpc":"2.0","id":1,"method":"applyCommands","params":{"commands":[{"op":"appendChord","token":"I"},{"op":"appendChord","token":"V"},{"op":"appendChord","token":"vi"},{"op":"appendChord","token":"IV"}]}}
{"jsonrpc":"2.0","id":2,"method":"suggestions","params":{"limit":3}}
{"op":"save"}
EOF
```

Methods: `getSong`, `getState`, `suggestions`, `commands`, `applyCommands` (`params: { commands,
undo }`). A bare command or array on a line is shorthand for `applyCommands` and is answered with
the result itself. `setInstrument` answers `unsupported` (the terminal only sends MIDI);
`exportMidi` also writes the file to `<data dir>/exports/` and returns its `path`. `play` opens
the MIDI port from the config (`--port`) on first use; at the end of input playback stops.

## The in-app assistant

The assistant panel (toolbar button or `Ctrl/Cmd+K`) uses exactly these commands: the server asks
the model for an explanation plus commands, and the panel shows them as a diff that the user
applies (one undo step) or discards. To set it up on the server see `docs/specs/deploy-v1.md`
step 7 (`ANTHROPIC_API_KEY`) and the `ASSISTANT_*` vars in `apps/api/wrangler.toml`.
