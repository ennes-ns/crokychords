import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AssistantAnswer, AssistantClient, AssistantQuestion } from '../src/assistant/client';
import { AssistantError, unavailableClient } from '../src/assistant/client';
import { createCroky } from '../src/assistant/croky';
import { bindAssistantKey, mountAssistant } from '../src/assistant/panel';
import { Store, initialState } from '../src/state';
import { quietHost, songFrom } from './commandHelpers';

/** A backend that answers from a queue and records the questions. */
function mockClient(answers: (AssistantAnswer | Error)[]) {
  const questions: AssistantQuestion[] = [];
  const client: AssistantClient = {
    status: () => Promise.resolve({ available: true }),
    ask: (q) => {
      questions.push(q);
      const next = answers.shift();
      if (next === undefined) return Promise.reject(new Error('no answer queued'));
      return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
    },
  };
  return { client, questions };
}

function setup(client: AssistantClient) {
  const store = new Store(
    initialState(
      songFrom({
        chords: [
          ['I', 4],
          ['V', 4],
          ['vi', 4],
          ['IV', 4],
        ],
      }),
    ),
  );
  const croky = createCroky(store, quietHost);
  const panel = mountAssistant({ store, croky, env: quietHost.env, client });
  document.body.append(panel.button, panel.element);
  const q = <T extends Element>(selector: string) => panel.element.querySelector<T>(selector);
  const tokens = () => store.state.song.chords.map((c) => c.token);
  return { store, panel, q, tokens };
}

/** Let pending promises (status, ask, apply) settle. */
const settle = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
};

async function askFor(env: ReturnType<typeof setup>, text: string): Promise<void> {
  const input = env.q<HTMLTextAreaElement>('.assistant-input');
  if (input === null) throw new Error('no input');
  input.value = text;
  input.dispatchEvent(new Event('input'));
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await settle();
}

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe('assistant panel', () => {
  it('opens from its button, checks availability and focuses the field', async () => {
    const { client } = mockClient([]);
    const env = setup(client);
    expect(env.panel.element.hidden).toBe(true);
    env.panel.button.click();
    await settle();
    expect(env.panel.element.hidden).toBe(false);
    expect(env.panel.button.getAttribute('aria-expanded')).toBe('true');
    expect(env.q('.assistant-status')?.textContent).toMatch(/nothing applies on its own/);
    expect(document.activeElement).toBe(env.q('.assistant-input'));
    env.panel.element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(env.panel.element.hidden).toBe(true);
  });

  it('Ctrl/Cmd+K toggles it', () => {
    const { client } = mockClient([]);
    const env = setup(client);
    const unbind = bindAssistantKey(window, env.panel);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true }));
    expect(env.panel.isOpen()).toBe(true);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'K', metaKey: true }));
    expect(env.panel.isOpen()).toBe(false);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k' }));
    expect(env.panel.isOpen()).toBe(false);
    unbind();
  });

  it('without a backend it says why and keeps the field disabled', async () => {
    const env = setup(unavailableClient());
    env.panel.setOpen(true);
    await settle();
    expect(env.q('.assistant-status')?.textContent).toMatch(/online version/);
    expect(env.q<HTMLTextAreaElement>('.assistant-input')?.disabled).toBe(true);
    expect(env.q<HTMLButtonElement>('.assistant-form button')?.disabled).toBe(true);
  });

  it('shows a proposal as a diff, applies it as one undo step', async () => {
    const { client, questions } = mockClient([
      {
        explanation: 'A darker ending with borrowed chords.',
        commands: [
          { op: 'replaceChord', index: 2, token: 'bVI' },
          { op: 'replaceChord', index: 3, token: 'bVII' },
          { op: 'appendChord', token: 'i' },
          { op: 'setTempo', bpm: 90 },
        ],
      },
    ]);
    const env = setup(client);
    env.store.set({ selected: 1 });
    env.panel.setOpen(true);
    await settle();
    await askFor(env, 'make the second half darker');

    expect(questions[0]).toMatchObject({ request: 'make the second half darker', selected: 1 });
    expect(questions[0]?.song.chords).toHaveLength(4);
    // Nothing changed yet.
    expect(env.tokens()).toEqual(['I', 'V', 'vi', 'IV']);
    const chips = [...env.panel.element.querySelectorAll('.diff-chip')].map((c) => [
      c.className.replace('diff-chip ', ''),
      c.textContent,
    ]);
    expect(chips).toEqual([
      ['same', 'I'],
      ['same', 'V'],
      ['replaced', 'vi → bVI'],
      ['replaced', 'IV → bVII'],
      ['added', '+i'],
    ]);
    expect(env.q('.diff-lines')?.textContent).toContain('Tempo: 120 → 90 BPM');
    expect(env.q('.assistant-msg.assistant')?.textContent).toBe(
      'A darker ending with borrowed chords.',
    );
    expect(env.q('.assistant-explanation')?.textContent).toBe('Proposed change');

    const apply = [...env.panel.element.querySelectorAll('button')].find(
      (b) => b.textContent === 'Apply',
    );
    apply?.click();
    await settle();
    expect(env.tokens()).toEqual(['I', 'V', 'bVI', 'bVII', 'i']);
    expect(env.store.state.song.tempo).toBe(90);
    expect(env.q<HTMLElement>('.assistant-proposal')?.hidden).toBe(true);
    env.store.undo();
    expect(env.tokens()).toEqual(['I', 'V', 'vi', 'IV']);
    expect(env.store.state.song.tempo).toBe(120);
  });

  it('Discard drops a proposal without touching the song', async () => {
    const { client } = mockClient([
      { explanation: 'Add a IV.', commands: [{ op: 'appendChord', token: 'IV' }] },
    ]);
    const env = setup(client);
    env.panel.setOpen(true);
    await settle();
    await askFor(env, 'one more');
    const discard = [...env.panel.element.querySelectorAll('button')].find(
      (b) => b.textContent === 'Discard',
    );
    discard?.click();
    expect(env.q<HTMLElement>('.assistant-proposal')?.hidden).toBe(true);
    expect(env.tokens()).toEqual(['I', 'V', 'vi', 'IV']);
    expect(env.store.canUndo).toBe(false);
  });

  it('a question gets an answer and no proposal; the next request carries the history', async () => {
    const { client, questions } = mockClient([
      { explanation: 'I–V–vi–IV: the axis progression.', commands: [] },
      { explanation: 'Done.', commands: [{ op: 'setTempo', bpm: 100 }] },
    ]);
    const env = setup(client);
    env.panel.setOpen(true);
    await settle();
    await askFor(env, 'what is this progression called?');
    expect(env.q<HTMLElement>('.assistant-proposal')?.hidden).toBe(true);
    expect(env.panel.element.querySelector('.assistant-msg.assistant')?.textContent).toContain(
      'axis progression',
    );
    await askFor(env, 'slower please');
    expect(questions[1]?.history).toEqual([
      { role: 'user', text: 'what is this progression called?' },
      {
        role: 'assistant',
        text: JSON.stringify({ explanation: 'I–V–vi–IV: the axis progression.', commands: [] }),
      },
    ]);
  });

  it('a proposal that does not fit the song shows why and offers no Apply', async () => {
    const { client } = mockClient([
      { explanation: 'Change chord 9.', commands: [{ op: 'replaceChord', index: 9, token: 'ii' }] },
    ]);
    const env = setup(client);
    env.panel.setOpen(true);
    await settle();
    await askFor(env, 'change it');
    expect(env.q('.assistant-proposal .warn')?.textContent).toMatch(/does not fit/);
    const labels = [...env.panel.element.querySelectorAll('.assistant-proposal button')].map(
      (b) => b.textContent,
    );
    expect(labels).toEqual(['Discard']);
  });

  it('a proposal follows edits made after it arrived', async () => {
    const { client } = mockClient([
      {
        explanation: 'Swap the last chord.',
        commands: [{ op: 'replaceChord', index: 3, token: 'ii' }],
      },
    ]);
    const env = setup(client);
    env.panel.setOpen(true);
    await settle();
    await askFor(env, 'swap');
    expect(env.q('.diff-chip.replaced')?.textContent).toBe('IV → ii');
    env.store.commit({ ...env.store.state.song, chords: env.store.state.song.chords.slice(0, 3) });
    expect(env.q('.assistant-proposal .warn')).not.toBeNull();
  });

  it('shows backend errors as a note and lets the user try again', async () => {
    const { client } = mockClient([
      new AssistantError('rate_limited', 'At most 6 requests a minute.'),
    ]);
    const env = setup(client);
    env.panel.setOpen(true);
    await settle();
    await askFor(env, 'again');
    expect(env.panel.element.querySelector('.assistant-msg.note')?.textContent).toBe(
      'At most 6 requests a minute.',
    );
    expect(env.q<HTMLTextAreaElement>('.assistant-input')?.disabled).toBe(false);
  });
});
