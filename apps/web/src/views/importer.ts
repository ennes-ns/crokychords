/**
 * The import preview (docs/specs/import-v1.md §B): a modal dialog with one entry per picked or
 * dropped file (title, key with an override, tempo, meter, a chord strip, the melody, parts and
 * their roles, warnings, dropped notes and chords), then Open (one file) or Save all (several).
 * Also the hidden file pickers and the drop target on the chord grid.
 */
import type { ImportReport, Mode, Song } from '@crokychords/core';
import { MODES, barPosition, isRestToken, parseNoteName, songKey } from '@crokychords/core';
import { h, option, replaceChildren } from '../dom';
import type { ImportEntry, ImportSource } from '../importer';
import { dragHasFiles, droppedFiles, importEntry, importableFiles, readSources } from '../importer';
import { MODE_LABELS, TONICS, colorDegree, degreeHue, tokenName } from '../music';

export interface ImporterOptions {
  /** Store the songs as new saved progressions and open the first. */
  save(songs: Song[]): Promise<void>;
}

export interface Importer {
  /** The dialog element (appended to the host, hidden while closed). */
  element: HTMLElement;
  /** Open the file picker / the folder picker. */
  pickFiles(): void;
  pickFolder(): void;
  /** Import these files and show the preview. */
  openFiles(files: readonly File[]): Promise<void>;
  /** Show the preview for already read sources (tests, agents). */
  openSources(sources: readonly ImportSource[], skipped?: readonly string[]): void;
  close(): void;
  isOpen(): boolean;
}

const ACCEPT =
  '.mid,.midi,.musicxml,.xml,audio/midi,audio/x-midi,application/vnd.recordare.musicxml+xml';
/** Chords shown in a preview strip; the rest are summarised. */
const STRIP_LIMIT = 48;

const ROLE_LABELS: Record<ImportReport['parts'][number]['role'], string> = {
  chords: 'chords',
  melody: 'melody',
  unused: 'not used',
  drums: 'drums, ignored',
};

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

/** "12 chords · 8 diatonic · 2 borrowed · 1 secondary · 1 rest". */
export function chordSummary(report: ImportReport): string {
  const c = report.chords;
  if (report.chordSource === 'none') return 'no chords found';
  const parts = [plural(c.total, 'chord')];
  if (c.diatonic > 0) parts.push(`${c.diatonic} diatonic`);
  if (c.borrowed > 0) parts.push(`${c.borrowed} borrowed`);
  if (c.secondary > 0) parts.push(`${c.secondary} secondary`);
  if (c.rests > 0) parts.push(plural(c.rests, 'rest'));
  if (report.chordSource === 'symbols') parts.push('from chord symbols');
  return parts.join(' · ');
}

/** The key's tonic as the picker spells it ('C#' for 'Db' when the picker has no 'Db'). */
function pickerTonic(tonic: string): string {
  if ((TONICS as readonly string[]).includes(tonic)) return tonic;
  try {
    const pc = parseNoteName(tonic);
    return TONICS[pc] ?? 'C';
  } catch {
    return 'C';
  }
}

function chordStrip(song: Song): HTMLElement {
  const key = songKey(song);
  const strip = h('ol', { class: 'import-strip', attrs: { 'aria-label': 'Chords' } });
  song.chords.slice(0, STRIP_LIMIT).forEach((chord) => {
    const rest = isRestToken(chord.token);
    const degree = rest ? null : colorDegree(chord.token);
    const name = rest ? 'rest' : tokenName(chord.token, key);
    strip.append(
      h(
        'li',
        {
          class: rest ? 'import-chord rest' : 'import-chord',
          style: {
            'flex-grow': String(chord.beats),
            ...(degree === null ? {} : { '--hue': String(degreeHue(degree)) }),
          },
          attrs: { title: `${chord.token} (${name}), ${plural(chord.beats, 'beat')}` },
        },
        rest ? '–' : chord.token,
      ),
    );
  });
  if (song.chords.length > STRIP_LIMIT) {
    strip.append(h('li', { class: 'import-more' }, `+${song.chords.length - STRIP_LIMIT} more`));
  }
  return strip;
}

export function mountImporter(host: HTMLElement, options: ImporterOptions): Importer {
  const doc = host.ownerDocument;
  let entries: ImportEntry[] = [];
  let skippedFiles: string[] = [];
  let busy = false;
  let returnFocus: HTMLElement | null = null;

  const fileInput = h('input', {
    class: 'import-file',
    props: { type: 'file', multiple: true, accept: ACCEPT, hidden: true },
    attrs: { 'aria-label': 'Import MIDI or MusicXML files' },
  });
  const folderInput = h('input', {
    class: 'import-folder',
    props: { type: 'file', multiple: true, hidden: true },
    attrs: { 'aria-label': 'Import a folder of MIDI or MusicXML files' },
  });
  folderInput.webkitdirectory = true;
  const onPicked = (input: HTMLInputElement): void => {
    const files = Array.from(input.files ?? []);
    input.value = '';
    if (files.length > 0) void openFiles(files);
  };
  fileInput.onchange = () => onPicked(fileInput);
  folderInput.onchange = () => onPicked(folderInput);

  const heading = h('h2', { class: 'import-title', props: { id: 'import-title' } }, 'Import');
  const status = h('p', { class: 'import-status', attrs: { role: 'status' } });
  const list = h('ul', { class: 'import-list' });
  const cancel = h('button', { props: { type: 'button' } }, 'Cancel');
  const accept = h('button', { class: 'primary', props: { type: 'button' } }, 'Open');
  const dialog = h(
    'div',
    {
      class: 'import-dialog',
      attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'import-title' },
    },
    h(
      'header',
      { class: 'import-head' },
      heading,
      h('span', { class: 'import-sub' }, 'MIDI/MusicXML import'),
    ),
    status,
    list,
    h('footer', { class: 'import-actions' }, cancel, accept),
  );
  const element = h(
    'div',
    { class: 'import-backdrop', props: { hidden: true } },
    dialog,
    fileInput,
    folderInput,
  );
  host.append(element);

  const ok = (): ImportEntry[] => entries.filter((e) => e.result !== null);

  const entryView = (entry: ImportEntry, index: number): HTMLElement => {
    const li = h('li', { class: 'import-entry', attrs: { 'data-entry': String(index) } });
    const fileName = h('span', { class: 'import-file-name' }, entry.source.name);
    const result = entry.result;
    if (result === null) {
      li.classList.add('failed');
      li.append(
        h('div', { class: 'import-entry-head' }, fileName),
        h(
          'p',
          { class: 'import-error', attrs: { role: 'alert' } },
          `Not imported: ${entry.error ?? ''}`,
        ),
      );
      return li;
    }
    const { song, report } = result;
    const tonic = h(
      'select',
      { attrs: { 'aria-label': `Key of ${report.title}`, 'data-field': 'tonic' } },
      ...TONICS.map((t) => option(t, t)),
    );
    tonic.value = pickerTonic(song.key.tonic);
    const mode = h(
      'select',
      { attrs: { 'aria-label': `Mode of ${report.title}`, 'data-field': 'mode' } },
      ...MODES.map((m) => option(m, MODE_LABELS[m])),
    );
    mode.value = song.key.mode;
    const rekey = (): void => {
      const next = MODES.find((m): m is Mode => m === mode.value) ?? song.key.mode;
      entries[index] = importEntry(entry.source, { tonic: tonic.value, mode: next });
      render();
      list.querySelector<HTMLElement>(`[data-entry="${index}"] [data-field="tonic"]`)?.focus();
    };
    tonic.onchange = rekey;
    mode.onchange = rekey;
    const keyNote =
      report.key.source === 'given'
        ? 'chosen'
        : `detected, ${Math.round(report.key.confidence * 100)}% sure` +
          (report.key.runnerUp === null
            ? ''
            : ` (else ${report.key.runnerUp.tonic} ${MODE_LABELS[report.key.runnerUp.mode].toLowerCase()})`);

    const facts = h(
      'div',
      { class: 'import-facts' },
      h('span', { class: 'import-fact' }, h('span', { class: 'label' }, 'Key'), tonic, mode),
      h('span', { class: 'import-key-note' }, keyNote),
      h('span', { class: 'import-fact' }, h('span', { class: 'label' }, 'BPM'), String(song.tempo)),
      h(
        'span',
        { class: 'import-fact' },
        h('span', { class: 'label' }, 'Meter'),
        `${song.meter.beats}/${song.meter.unit}`,
      ),
    );
    const parts = report.parts
      .filter((p) => p.notes > 0)
      .map((p) => `${p.name}: ${ROLE_LABELS[p.role]}`)
      .join(' · ');
    const lines: HTMLElement[] = [
      h('p', { class: 'import-line' }, chordSummary(report)),
      chordStrip(song),
      h(
        'p',
        { class: 'import-line' },
        report.melody.notes === 0 ? 'No melody' : `Melody: ${plural(report.melody.notes, 'note')}`,
        parts === '' ? '' : ` · Parts: ${parts}`,
      ),
    ];
    if (report.warnings.length > 0) {
      lines.push(
        h('ul', { class: 'import-warnings' }, ...report.warnings.map((w) => h('li', {}, w))),
      );
    }
    const droppedCount = report.dropped.length + report.droppedMore;
    if (droppedCount > 0) {
      lines.push(
        h(
          'details',
          { class: 'import-dropped' },
          h('summary', {}, `Dropped (${droppedCount})`),
          h(
            'ul',
            {},
            ...report.dropped.map((d) =>
              h(
                'li',
                {},
                d.beat === null ? '' : `${barPosition(d.beat, song.meter)}: `,
                `${d.kind} — ${d.detail}`,
              ),
            ),
            report.droppedMore > 0 ? h('li', {}, `… and ${report.droppedMore} more`) : null,
          ),
        ),
      );
    }
    li.append(
      h(
        'div',
        { class: 'import-entry-head' },
        h('b', { class: 'import-song-title' }, report.title),
        fileName,
      ),
      facts,
      ...lines,
    );
    return li;
  };

  const render = (): void => {
    const good = ok().length;
    const failed = entries.length - good;
    heading.textContent = entries.length === 1 ? 'Import a file' : `Import ${entries.length} files`;
    const notes = [];
    if (busy) notes.push('Reading…');
    if (failed > 0) notes.push(`${failed} could not be imported`);
    if (skippedFiles.length > 0) notes.push(`Skipped: ${skippedFiles.join(', ')}`);
    if (!busy && entries.length === 0) notes.push('No MIDI or MusicXML files in the selection.');
    status.textContent = notes.join(' · ');
    replaceChildren(list, ...entries.map(entryView));
    accept.textContent = good > 1 ? `Save all (${good})` : 'Open';
    accept.title =
      good > 1
        ? 'Save every imported file as its own progression and open the first'
        : 'Save the import as a new progression and open it';
    accept.disabled = busy || good === 0;
  };

  const focusables = (): HTMLElement[] =>
    Array.from(
      dialog.querySelectorAll<HTMLElement>(
        'button:not(:disabled), select:not(:disabled), summary, [tabindex]:not([tabindex="-1"])',
      ),
    );

  const open = (): void => {
    if (element.hidden) {
      const active = doc.activeElement;
      returnFocus = active instanceof HTMLElement ? active : null;
    }
    element.hidden = false;
    render();
    (focusables().find((el) => el === accept && !accept.disabled) ?? cancel).focus();
  };

  const close = (): void => {
    element.hidden = true;
    entries = [];
    skippedFiles = [];
    replaceChildren(list);
    returnFocus?.focus();
    returnFocus = null;
  };

  const openSources = (sources: readonly ImportSource[], skipped: readonly string[] = []): void => {
    entries = sources.map((s) => importEntry(s));
    skippedFiles = [...skipped];
    busy = false;
    open();
  };

  const openFiles = async (files: readonly File[]): Promise<void> => {
    const picked = importableFiles(files);
    entries = [];
    skippedFiles = picked.skipped;
    busy = true;
    open();
    try {
      const sources = await readSources(picked.files);
      openSources(sources, picked.skipped);
    } catch (e) {
      busy = false;
      skippedFiles.push(`reading failed: ${e instanceof Error ? e.message : String(e)}`);
      render();
    }
  };

  cancel.onclick = close;
  accept.onclick = () => {
    const songs = ok().flatMap((e) => (e.result === null ? [] : [e.result.song]));
    if (songs.length === 0) return;
    busy = true;
    render();
    void options.save(songs).then(
      () => {
        busy = false;
        close();
      },
      (e: unknown) => {
        busy = false;
        skippedFiles = [`saving failed: ${e instanceof Error ? e.message : String(e)}`];
        render();
      },
    );
  };
  element.addEventListener('pointerdown', (e) => {
    if (e.target === element) close();
  });
  // The dialog keeps the keyboard: Escape cancels, Tab cycles inside, no app shortcuts.
  dialog.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
      return;
    }
    if (e.key !== 'Tab') return;
    const items = focusables();
    const first = items[0];
    const last = items.at(-1);
    if (first === undefined || last === undefined) return;
    if (e.shiftKey && doc.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && doc.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  });
  dialog.addEventListener('keyup', (e) => e.stopPropagation());

  return {
    element,
    pickFiles: () => fileInput.click(),
    pickFolder: () => folderInput.click(),
    openFiles,
    openSources,
    close,
    isOpen: () => !element.hidden,
  };
}

/**
 * Let `target` (the chord grid) take dropped files: an outline while files are dragged over it,
 * the importer on drop.
 */
export function bindImportDrop(target: HTMLElement, importer: Pick<Importer, 'openFiles'>): void {
  let depth = 0;
  const set = (on: boolean): void => {
    target.classList.toggle('drop-target', on);
  };
  target.addEventListener('dragenter', (e) => {
    if (!dragHasFiles(e.dataTransfer)) return;
    e.preventDefault();
    depth++;
    set(true);
  });
  target.addEventListener('dragover', (e) => {
    if (!dragHasFiles(e.dataTransfer)) return;
    e.preventDefault();
    if (e.dataTransfer !== null) e.dataTransfer.dropEffect = 'copy';
  });
  target.addEventListener('dragleave', () => {
    depth = Math.max(0, depth - 1);
    if (depth === 0) set(false);
  });
  target.addEventListener('drop', (e) => {
    if (!dragHasFiles(e.dataTransfer) || e.dataTransfer === null) return;
    e.preventDefault();
    depth = 0;
    set(false);
    const transfer = e.dataTransfer;
    void droppedFiles(transfer).then((files) => importer.openFiles(files));
  });
}
