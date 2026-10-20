/**
 * The assistant panel (docs/specs/assistant-v1.md §B1): the user types a request, the assistant
 * answers with a one-line explanation and commands, and the panel shows those commands as a diff
 * against the current song. Nothing changes until Apply, which runs them through `window.croky`
 * as one undo step; Discard drops them.
 */
import type { Command } from '@crokychords/core';
import { ASSISTANT_OPS } from '@crokychords/core';
import { h, replaceChildren } from '../dom';
import type { Store } from '../state';
import { pixelSvg } from '../views/toolbar';
import type { AssistantClient, AssistantTurn } from './client';
import type { Croky } from './croky';
import { prepare, songJson } from './croky';
import type { ChordChange } from './diff';
import { describeChanges, diffChords } from './diff';
import type { EngineEnv } from './engine';

/** Earlier turns sent with a request (user and assistant alternate). */
export const HISTORY_TURNS = 8;

const BUBBLE_ROWS = [
  '.#######.',
  '#.......#',
  '#.#.#.#.#',
  '#.......#',
  '.###.###.',
  '....##...',
  '....#....',
  '.........',
];

export interface AssistantPanel {
  element: HTMLElement;
  /** The toolbar's toggle button. */
  button: HTMLButtonElement;
  isOpen(): boolean;
  setOpen(open: boolean): void;
}

export interface AssistantDeps {
  store: Store;
  croky: Croky;
  env: EngineEnv;
  client: AssistantClient;
}

interface Proposal {
  explanation: string;
  commands: unknown[];
}

function chip(change: ChordChange): HTMLElement {
  const beats = (b: number) => (b === 4 ? '' : ` ·${b}`);
  if (change.kind === 'replaced') {
    return h(
      'span',
      {
        class: 'diff-chip replaced',
        attrs: { title: `replaced ${change.before} with ${change.token}` },
      },
      h('s', {}, `${change.before}${beats(change.beforeBeats)}`),
      ' → ',
      h('b', {}, `${change.token}${beats(change.beats)}`),
    );
  }
  const label = { same: '', added: '+', removed: '' }[change.kind];
  const text = `${label}${change.token}${beats(change.beats)}`;
  return h(
    'span',
    {
      class: `diff-chip ${change.kind}`,
      attrs: { title: change.kind === 'same' ? 'unchanged' : change.kind },
    },
    change.kind === 'removed' ? h('s', {}, text) : text,
  );
}

export function mountAssistant(deps: AssistantDeps): AssistantPanel {
  const { store, croky, env, client } = deps;
  const history: AssistantTurn[] = [];
  let proposal: Proposal | null = null;
  let pending = false;
  let available = false;

  const button = h('button', {
    class: 'tool-icon assistant-toggle',
    props: { type: 'button' },
    attrs: {
      'aria-label': 'Assistant',
      'aria-expanded': 'false',
      'aria-controls': 'assistant-panel',
      title: 'Assistant (Ctrl/Cmd+K): ask for changes or about the song',
    },
  });
  button.append(pixelSvg(BUBBLE_ROWS, 'pixel-icon', () => 'ink', button.ownerDocument));

  const status = h('p', { class: 'hint assistant-status', attrs: { role: 'status' } });
  const log = h('div', { class: 'assistant-log', attrs: { 'aria-live': 'polite' } });
  const proposalBox = h('div', { class: 'assistant-proposal', props: { hidden: true } });
  const input = h('textarea', {
    class: 'assistant-input',
    props: { rows: 3, placeholder: 'Make the second half darker…' },
    attrs: { 'aria-label': 'Ask the assistant' },
  });
  const send = h('button', { class: 'primary', props: { type: 'button' } }, 'Send');
  const close = h(
    'button',
    {
      class: 'assistant-close',
      props: { type: 'button' },
      attrs: { 'aria-label': 'Close the assistant' },
    },
    '×',
  );
  const element = h(
    'aside',
    {
      class: 'panel assistant',
      props: { id: 'assistant-panel', hidden: true },
      attrs: { 'aria-label': 'Assistant' },
    },
    h('div', { class: 'assistant-head' }, h('h2', {}, 'Assistant'), close),
    status,
    log,
    proposalBox,
    h('div', { class: 'assistant-form' }, input, send),
  );

  const say = (role: 'user' | 'assistant' | 'note', text: string): void => {
    log.append(h('p', { class: `assistant-msg ${role}` }, text));
    log.scrollTop = log.scrollHeight;
  };

  const renderControls = (): void => {
    input.disabled = !available || pending;
    send.disabled = !available || pending || input.value.trim() === '';
    send.textContent = pending ? 'Thinking…' : 'Send';
  };

  const renderProposal = (): void => {
    if (proposal === null) {
      proposalBox.hidden = true;
      replaceChildren(proposalBox);
      return;
    }
    const current = proposal;
    proposalBox.hidden = false;
    const prepared = prepare(store, env, current.commands, { undo: 'batch' }, ASSISTANT_OPS);
    const discard = h('button', { props: { type: 'button' } }, 'Discard');
    discard.onclick = () => {
      proposal = null;
      say('note', 'Discarded.');
      renderProposal();
    };
    if (!prepared.ok) {
      const { index, message } = prepared.error;
      replaceChildren(
        proposalBox,
        h('p', { class: 'assistant-explanation' }, 'Proposed change'),
        h(
          'p',
          { class: 'warn' },
          `This proposal does not fit the song (command ${index + 1}: ${message}).`,
        ),
        h('div', { class: 'assistant-actions' }, discard),
      );
      return;
    }
    const before = store.state.song;
    const after = prepared.preview.song;
    const chords = diffChords(before.chords, after.chords);
    const lines = describeChanges(before, after);
    const changed = chords.some((c) => c.kind !== 'same') || lines.length > 0;
    const apply = h(
      'button',
      { class: 'primary', props: { type: 'button', disabled: !changed } },
      'Apply',
    );
    apply.onclick = () => void doApply(prepared.commands);
    replaceChildren(
      proposalBox,
      h('p', { class: 'assistant-explanation' }, 'Proposed change'),
      h(
        'div',
        { class: 'diff-chords', attrs: { 'aria-label': 'Progression after the change' } },
        ...(chords.length === 0 ? [h('span', { class: 'hint' }, 'no chords')] : chords.map(chip)),
      ),
      lines.length === 0
        ? null
        : h('ul', { class: 'diff-lines' }, ...lines.map((l) => h('li', {}, l))),
      changed ? null : h('p', { class: 'hint' }, 'This would not change the song.'),
      h('div', { class: 'assistant-actions' }, apply, discard),
    );
  };

  const doApply = async (commands: Command[]): Promise<void> => {
    const result = await croky.applyCommands(commands, { undo: 'batch' });
    if (result.ok) {
      proposal = null;
      say('note', 'Applied. Ctrl/Cmd+Z undoes it.');
    } else {
      say('note', `Not applied: ${result.error.message}.`);
    }
    renderProposal();
  };

  const ask = async (): Promise<void> => {
    const request = input.value.trim();
    if (request === '' || pending || !available) return;
    pending = true;
    proposal = null;
    renderProposal();
    say('user', request);
    input.value = '';
    renderControls();
    try {
      const answer = await client.ask({
        request,
        song: songJson(store.state.song),
        selected: store.state.selected,
        history: history.slice(-HISTORY_TURNS),
      });
      say('assistant', answer.explanation);
      history.push(
        { role: 'user', text: request },
        {
          role: 'assistant',
          text: JSON.stringify({ explanation: answer.explanation, commands: answer.commands }),
        },
      );
      if (answer.commands.length > 0) proposal = answer;
    } catch (e) {
      say('note', e instanceof Error ? e.message : String(e));
    } finally {
      pending = false;
      renderControls();
      renderProposal();
    }
  };

  const refreshStatus = async (): Promise<void> => {
    status.textContent = 'Checking whether the assistant is available…';
    const result = await client.status();
    available = result.available;
    status.textContent = result.available
      ? 'Ask for a change or about the song. Changes are shown first; nothing applies on its own.'
      : result.reason;
    renderControls();
  };

  const setOpen = (open: boolean): void => {
    element.hidden = !open;
    button.setAttribute('aria-expanded', String(open));
    button.classList.toggle('active', open);
    if (open) {
      void refreshStatus().then(() => {
        if (!element.hidden && available) input.focus();
      });
    } else if (element.contains(document.activeElement)) {
      button.focus();
    }
  };

  button.onclick = () => setOpen(element.hidden);
  close.onclick = () => setOpen(false);
  send.onclick = () => void ask();
  input.addEventListener('input', renderControls);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      void ask();
    }
  });
  element.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    setOpen(false);
  });
  // A proposal is always shown against the song as it is now.
  store.subscribe((state, previous) => {
    if (proposal !== null && state.song !== previous.song) renderProposal();
  });
  renderControls();

  return { element, button, isOpen: () => !element.hidden, setOpen };
}

/** Ctrl/Cmd+K anywhere toggles the panel. Returns the unbind. */
export function bindAssistantKey(target: EventTarget, panel: AssistantPanel): () => void {
  const down = (e: Event): void => {
    if (!(e instanceof KeyboardEvent)) return;
    if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey || e.key.toLowerCase() !== 'k') return;
    e.preventDefault();
    panel.setOpen(!panel.isOpen());
  };
  target.addEventListener('keydown', down, true);
  return () => target.removeEventListener('keydown', down, true);
}
