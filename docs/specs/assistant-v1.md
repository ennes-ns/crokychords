# Spec: Assistant v1 — a command API for agents and an AI helper in the editor

Status: in progress (issue #97). Owner: main session. One PR on branch `feat/assistant` touching
`packages/core` (the command contract), `apps/web` (`window.croky`, the assistant panel), `apps/api`
(`/api/assistant`), `crates/croky-tui` (commands over stdin), `tools/agent/` and the docs.
Decisions: [ADR 0004](../adr/0004-command-api.md).

## Goal

Two layers, so a person in the app and an external agent can both work on a song:

- **A. Command API** (first): a documented, stable, machine-readable way to read and change a song
  and drive playback without a mouse: `window.croky` in the web app and the same command set over
  stdin in the terminal app. Commands are JSON, validated, and every song edit is one undo step.
- **B. Assistant** (second): a side panel in the web app where the user types a request ("make the
  second half darker", "suggest a bridge", "what is this progression called"); the assistant answers
  with commands from layer A plus a one-line explanation, shown as a **diff** that the user applies
  or discards. Nothing is applied without a click.

Non-goals for v1: streaming answers, the assistant in the terminal app, the assistant editing the
pattern steps or sound settings, voice input, multi-song operations.

## A. The command API

### A1. The contract (`packages/core/src/commands.ts`)

A command is a JSON object with an `op` and its arguments. The schemas are zod (`commandSchema`),
shared by the web app (validation before anything runs) and the Worker (the assistant's answers
and the JSON schema given to the model). The terminal app parses the same commands from
`serde_json` values with the same rules and error paths (`crates/croky-tui/src/commands.rs`). The contract fixture
`packages/core/test/fixtures/commands-v1.json` (`schema_version: 1`) lists every op and a set of
scenarios (start song, commands, expected song or error); the TypeScript and the Rust tests both
run it, so the two implementations cannot drift.

Conventions:

- Indices are 0-based (`index`, `at`); MIDI channels are 0–15 as in the song JSON (shown 1–16).
- Beats are quarter notes; chord lengths are multiples of ¼ beat, as in the song model.
- A `track` is a track id (string) or a track index (integer); `setInstrument` also takes
  `"melody"`.
- Chord tokens use the one token format, `roman-numeral-v1`, or `rest`.
- Unknown ops and unknown fields are refused, not ignored.

### A2. Commands

**Song edits** (each one undo step; the result has `changed: false` when the song stayed equal):

| op | Arguments | What |
| -- | --------- | ---- |
| `appendChord` | `token`, `beats?` | Add a chord at the end. Length: `beats`, else the previous chord's, else 4 or the rest of the bar (as the "+" slot). Result: `index`. |
| `insertChord` | `at`, `token`, `beats?` | Insert so that the new chord gets index `at` (0..length). Same default length as above (the chord before it). |
| `replaceChord` | `index`, `token`, `beats?` | Replace a chord's token (and length when `beats` is given). |
| `deleteChord` | `index` | Remove a chord. |
| `setChordBeats` | `index`, `beats` | Change a chord's length. |
| `setChords` | `chords: [{ token, beats }]` | Replace the whole progression (at most 1024 chords). |
| `pick` | `token`, `insert?` | What a click on a Next chord suggestion does: replace the selected chord, append on the "+" slot, or insert after the selected chord (`insert: true`, which selects the new chord). |
| `setKey` | `tonic?`, `mode?` | Key (tonic as a note name: `C`, `F#`, `Bb`; mode: `major`, `minor`, `dorian`, `phrygian`, `lydian`, `mixolydian`, `locrian`, `harmonicMinor`, `phrygianDominant`). At least one. |
| `setTempo` | `bpm` | Integer 20–300 (the editor's range). |
| `setMeter` | `beats`, `unit` | Beats per bar 1–32, unit 1, 2, 4, 8, 16 or 32. |
| `setTitle` | `title` | At most 200 characters. |
| `addNote` | `beat`, `length`, `degree`, `octave?`, `accidental?` | Place a melody note (`melody-v1.md` A1: degree 1–7, octave −3..3, accidental −1/0/1, beat and length on the ¼-beat grid). The lane stays monophonic: notes starting inside it are removed, a note running into it is shortened. Result: `index`. |
| `deleteNote` | `index` | Remove a melody note. |
| `setNotes` | `notes: [note]` | Replace the whole melody (sorted by beat; overlapping notes are refused). |
| `setMelody` | `channel?`, `muted?` | The melody lane's MIDI channel and mute. |
| `addTrack` | `role` | Add a band track with the role's defaults on the next free channel. Result: `track` (its id). |
| `removeTrack` | `track` | Remove a track. |
| `setTrack` | `track`, `name?`, `role?`, `channel?`, `octave?`, `voicing?`, `velocity?`, `gate?`, `muted?`, `transpose?` | Change a track (`tracks-v1.md` A1 ranges: octave −1..9, velocity 1–127, gate (0, 1], transpose −24..24). Changing `role` does not apply the role's defaults. |
| `setTrackPattern` | `track`, `preset` | Give a track a built-in pattern preset (`sustain`, `bass-quarters`, `arp-up-8`, …) or a song preset id. |
| `newSong` | — | A new song with the same key, tempo, meter and band; chords and melody empty (the app's New). |

**History:** `undo`, `redo` (result `changed: false` when there was nothing to undo or redo).

**View state** (not in the song, no undo): `select { index: number | null }` (a chord, or `null` for
the "+" slot), `setLoop { enabled?, range? }` (`range` `{ start, end }` in beats or `null` to clear;
setting a range turns looping on, as in the app).

**Sound** (a listening preference of this browser, no undo; web only):
`setInstrument { track, instrument }` with an instrument id of `soundfonts-v1.md` / `sampler-v1.md`
(`piano`, `lead`, `sf-strings`, `sampler-1`, …). The terminal app answers `unsupported`.

**Transport:** `play { from? }` (from a beat; default the loop start when looping, else 0), `stop`,
`audition { token }` (sound one chord through the selected track). In the browser these use Web
Audio and Web MIDI out; in the terminal the MIDI port.

**Files:** `exportMidi` (result `{ fileName, bytes, base64 }`: the `.mid` file as `songToMidi`
writes it, with the General MIDI programs of the current sound settings; the terminal app also
writes it to `<data dir>/exports/` and returns `path`), `save` (write pending edits now: the web
app's autosave, the terminal's record or `--song` file), `importFile { name, data, tonic?, mode? }`
(replace the song with a MIDI/MusicXML file given in base64, one undo step; web only, the terminal
app answers `unsupported`; [import-v1](import-v1.md) §C).

### A3. Running commands

`applyCommands(commands, options?)` takes one command or an array (at most 256):

1. Every command is validated against its schema. Any error: nothing runs.
2. The whole batch is then **dry-run** on a copy of the song, the selection, the loop and the undo
   history, so an index that does not exist (`not_found`) or an edit that would leave the song
   invalid is found before anything changes. Nothing runs then either.
3. The commands run in order. Each song edit is committed as its own undo step. With
   `{ undo: 'batch' }` the whole batch becomes **one** undo step (the assistant's Apply uses this);
   `undo`/`redo` are refused in such a batch.
4. A transport or file command that fails while running (no MIDI port, nothing to play) stops the
   batch; the commands before it stay applied (`applied` says how many).

Result:

```ts
type ApplyResult =
  | { ok: true; applied: number; results: CommandResult[] }
  | { ok: false; applied: number; results: CommandResult[]; error: CommandError };

interface CommandResult { op: string; changed?: boolean; index?: number; track?: string; /* per op */ }
interface CommandError {
  code: 'invalid' | 'not_found' | 'unsupported' | 'failed';
  index: number;   // position of the command in the batch (0 for a single command)
  op: string | null;
  path: string;    // inside the command, e.g. 'beats', 'notes[2].degree'; '' for the whole command
  message: string;
}
```

Codes: `invalid` — the command does not match the schema or would make the song invalid;
`not_found` — the chord, note, track or preset does not exist; `unsupported` — the op exists but
not in this app; `failed` — playback, MIDI, export or saving did not work.

### A4. `window.croky` (web, `apps/web/src/assistant/croky.ts`)

Set once the app has booted; `document` then fires `croky:ready`.

| Member | What |
| ------ | ---- |
| `version` | `1` (the contract's `schema_version`). |
| `getSong()` | The song as `serializeSong` writes it (schema 4 JSON object). |
| `getState()` | `{ selected, playing, cursor, loop: { enabled, range }, canUndo, canRedo, table: { status, name }, audioReady }`. |
| `suggestions({ at?, limit?, popular?, diatonicOnly? })` | The Next chord list for slot `at` (a chord index or `null` for the "+" slot; default the selection): `{ context, items: [{ token, name, probability }] }`. |
| `commands()` | Every op with its summary, kind and an example, plus the JSON schema of a command. |
| `applyCommands(commands, options?)` | §A3; returns a `Promise<ApplyResult>`. |
| `exportMidi()` | The `.mid` file as a `Uint8Array`. |

Everything returned is plain JSON (except `exportMidi`), so `Runtime.evaluate` with
`returnByValue: true` over CDP carries it unchanged.

### A5. The terminal app (`croky-tui --commands`)

`croky-tui --commands` runs without a screen: it reads one JSON-RPC 2.0 request per line on stdin
and writes one response per line on stdout (`--song PATH` edits a file, otherwise the session's
records as usual). Methods: `getSong`, `getState`, `suggestions`, `commands`, `applyCommands`
(`params: { commands, undo? }`); `commands` lists the ops with their kind and whether the terminal
supports them (summaries live in the core contract). A bare command object or array on a line is shorthand for
`applyCommands` and is answered with the `ApplyResult` itself. Errors that are not about a command
use JSON-RPC codes (`-32700` parse error, `-32600` invalid request, `-32601` unknown method,
`-32602` bad params). Records are saved after every request that changed the song; a `--song`
file only with `save`. MIDI opens on the first `play` or `audition`; at the end of input playback
stops and the program exits.

### A6. Running the app headlessly (`docs/howto/agents.md`, `tools/agent/`)

- `tools/agent/cdp.mjs`: a dependency-free CDP client (Node 22 has `WebSocket`) that starts
  Chromium with `--headless=new --mute-audio --autoplay-policy=no-user-gesture-required` on a
  random debugging port above 9400 and a fresh profile, opens a page and evaluates expressions.
- `tools/agent/croky.mjs`: starts the Vite dev server on a random port, opens the app, and either
  runs a JSON command file (`--run FILE`) or the integration scenario (`--check`): builds I–V–vi–IV
  through `window.croky`, adds a melody, plays and stops (muted), undoes and redoes, and exports a
  `.mid` that it parses and checks (format 1, the band tracks and a melody track). CI runs
  `--check` in the `pnpm check` job.
- The howto explains the three ways to drive the app: CDP + `window.croky`, the script, and the
  terminal app over stdin; and the rule that no run ever plays sound on the host.

## B. The assistant

### B1. Panel (`apps/web/src/assistant/panel.ts`)

- Opened with the Assistant button in the toolbar (pixel icon, `aria-expanded`) or `Ctrl/Cmd+K`;
  it opens over the side column (the stage keeps its size), Esc or the button closes it.
- A text field (Enter sends, Shift+Enter a new line), the conversation of this session (the user's
  requests and the assistant's one-line explanations), and the **proposal** of the last answer:
  - the explanation as the last line of the conversation, and the proposal under "Proposed change";
  - the progression as chips, before → after: added chords marked `+`, replaced chords `old → new`,
    removed chords struck through, unchanged chords dim; the changed key, tempo, meter, title,
    melody (`+3 notes, −1 note`) and band (`Bass: pattern bass-root-fifth`) as lines;
  - **Apply** (all commands as one undo step, through `applyCommands(…, { undo: 'batch' })`) and
    **Discard**. A proposal whose dry run fails shows the error and no Apply button.
  - An answer without commands (a question) shows only the explanation.
- When the song changes after an answer arrived, the proposal is recomputed against the current
  song; Apply always checks again.
- Unavailable: without the online version (the build has no API: `VITE_SYNC` off), offline, or when
  the server says the assistant is not set up, the panel says so and the field is disabled.
  Nothing else in the app depends on the assistant.

### B2. Route (`apps/api/src/assistant.ts`)

- `GET /api/assistant` → `{ available, model, limits: { per_minute, per_day }, used_today }`.
- `POST /api/assistant` with `{ request, song, selected?, history? }`:
  `request` 1–2000 characters; `song` checked with `validateSong`; `selected` a chord index or
  `null`; `history` at most 8 earlier turns `{ role: 'user' | 'assistant', text }` (≤ 4000 chars
  each). Body ≤ 256 KiB. → `200 { explanation, commands, usage: { input_tokens, output_tokens } }`.
- Behind Access like every `/api/*` route (same JWT check, same origin rule; CORS allows `POST`).
- **Limits** (D1 table `assistant_usage`, migration `0002`): per user at most
  `ASSISTANT_USER_MINUTE_REQUESTS` requests per minute and `ASSISTANT_USER_DAILY_REQUESTS` per UTC
  day → `429 rate_limited`; all users together at most `ASSISTANT_DAILY_BUDGET_USD` of model cost
  per UTC day (estimated from the reported tokens and the model's prices) → `429 budget_exhausted`.
  The counters are claimed with one conditional upsert each, so parallel requests cannot overshoot
  the request limits; the budget can overshoot by at most the requests in flight.
- **Model call:** `POST https://api.anthropic.com/v1/messages` with `fetch` (no SDK), model
  `ASSISTANT_MODEL` (default `claude-sonnet-5-5`), `x-api-key` from the secret `ANTHROPIC_API_KEY`,
  adaptive thinking at effort `low`, `max_tokens` 8000, the system prompt (B3, cached), the earlier
  turns and the new request with the song JSON. The answer is constrained with
  `output_config.format` (a JSON schema built from the assistant's commands) when
  `ASSISTANT_OUTPUT` is `schema` (default), else asked for in the prompt only (`text`). With
  `ASSISTANT_FALLBACKS = "default"` the request opts into server-side fallback on a refusal.
- The answer is parsed and validated with the core schema (assistant ops only, at most 64
  commands, explanation ≤ 500 characters). A refusal, a cut-off or an unusable answer →
  `502 assistant_failed`; the model API failing or overloaded → `503 assistant_busy`; no key →
  `503 assistant_unavailable`. Logs never contain the song, the request text or the key.
- Configuration (`wrangler.toml` `[vars]`, secret by `wrangler secret put ANTHROPIC_API_KEY`):

| Name | Kind | Default |
| ---- | ---- | ------- |
| `ANTHROPIC_API_KEY` | secret | — (assistant unavailable without it) |
| `ASSISTANT_MODEL` | var | `claude-sonnet-5-5` |
| `ASSISTANT_DAILY_BUDGET_USD` | var | `1` |
| `ASSISTANT_USER_DAILY_REQUESTS` | var | `50` |
| `ASSISTANT_USER_MINUTE_REQUESTS` | var | `6` |
| `ASSISTANT_OUTPUT` | var | `schema` |
| `ASSISTANT_FALLBACKS` | var | `default` (empty: off) |

### B3. System prompt (`apps/api/src/assistantPrompt.ts`)

States what Croky Chords is; the token grammar (`roman-numeral-v1`, with examples per part); the
song JSON fields; every assistant command with its arguments (generated from the core command
info, so it cannot drift from the schema); and the rules: answer with one JSON object
`{ "explanation": string, "commands": Command[] }`; the explanation is one sentence; questions are
answered in the explanation with no commands; indices are 0-based and every command sees the song
as the commands before it left it (as `applyCommands` runs them); prefer the smallest set of
commands; never invent ops or fields.

Assistant ops: every song edit of A2 except `pick` and `newSong`; no history, view, sound,
transport or file commands.

## Tests

- core: every command's schema (valid and invalid examples, paths of errors), `parseCommands`
  limits, the assistant JSON schema uses only keywords the structured-output API accepts, the
  contract fixture (ops list).
- web: the engine for every command incl. `not_found`, `invalid`, undo and redo, batch undo,
  dry-run atomicity; `window.croky` (getSong, getState, suggestions, commands, applyCommands,
  exportMidi); the fixture scenarios; the diff; the panel with a mocked backend (unavailable,
  answer with commands → diff → Apply → one undo step, Discard, question without commands, errors).
- api: availability, auth, validation, rate limits (minute, day), budget, the request sent to the
  model (mocked `fetch`), refusal / bad answer / upstream errors.
- tui: serde parsing of every op and the error codes, the fixture scenarios, JSON-RPC framing and
  errors.
- integration: `node tools/agent/croky.mjs --check` (headless, muted).
