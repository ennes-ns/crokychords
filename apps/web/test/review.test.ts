/**
 * The maintainer's review queue page (docs/specs/community-v1.md §4.5, docs/specs/moderation-v1.md
 * §5.1) against the fake bank.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CONFIRM_MS, autoSummary, mountReview, topScores } from '../src/review/queue';
import { CommunityError } from '../src/sync/community';
import { FakeCommunity, queueItem } from './fakeCommunity';

const settle = async (): Promise<void> => {
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
};

function mount(api: FakeCommunity) {
  const root = document.createElement('main');
  document.body.append(root);
  const field = <T extends HTMLElement>(name: string, scope: ParentNode = root): T => {
    const el = scope.querySelector<T>(`[data-field="${name}"]`);
    if (el === null) throw new Error(`no ${name}`);
    return el;
  };
  return { root, field, ready: mountReview(root, api) };
}

afterEach(() => {
  document.body.replaceChildren();
});

describe('review queue page', () => {
  it('is closed to everyone but the maintainer', async () => {
    const api = new FakeCommunity();
    api.queueItems = [queueItem('Hidden')];
    const { field, ready } = mount(api);
    await ready;
    expect(field('status').textContent).toBe('This page is for the maintainer.');
    expect(api.named('queue')).toHaveLength(0);
    expect(field('queue').children).toHaveLength(0);
  });

  it('shows the sign-in problem when the profile fails', async () => {
    const api = new FakeCommunity();
    api.fail.set(
      'me',
      new CommunityError(
        'signed-out',
        'Sign in again to use the community bank (reload the page).',
      ),
    );
    const { field, ready } = mount(api);
    await ready;
    expect(field('status').textContent).toContain('Sign in again');
  });

  it('lists pending shares with a player that never starts, lists and rejects by hand', async () => {
    const api = new FakeCommunity();
    api.me_ = { handle: 'boss', maintainer: true };
    const first = queueItem('Vocal ah', { tags: ['vocal'], owner: 'dusty' });
    const second = queueItem('Long talk');
    api.queueItems = [first, second];
    const { root, field, ready } = mount(api);
    await ready;
    expect(field('status').textContent).toBe('2 waiting for review, oldest first.');
    const items = root.querySelectorAll<HTMLElement>('.review-item');
    expect(items).toHaveLength(2);
    expect(items[0]?.textContent).toContain('by dusty');
    expect(items[0]?.textContent).toContain('vocal');
    const player = field<HTMLAudioElement>('player', items[0] ?? root);
    expect(player.getAttribute('src') ?? player.src).toContain(`/api/samples/${first.id}`);
    expect(player.preload).toBe('none');
    expect(player.autoplay).toBe(false);

    field<HTMLButtonElement>('list', items[0] ?? root).click();
    await settle();
    expect(api.named('decide')[0]?.args).toEqual([first.id, { action: 'list', revision: 1 }]);
    expect(root.querySelectorAll('.review-item')).toHaveLength(1);
    expect(field('status').textContent).toBe('Listed: Vocal ah');

    const rest = root.querySelector<HTMLElement>('.review-item') ?? root;
    const reason = field<HTMLSelectElement>('reason', rest);
    const reject = field<HTMLButtonElement>('reject', rest);
    // No reason, no rejection.
    expect(reject.disabled).toBe(true);
    reject.click();
    await settle();
    expect(api.named('decide')).toHaveLength(1);
    reason.value = 'speech';
    reason.dispatchEvent(new Event('change'));
    expect(reject.disabled).toBe(false);
    reject.click();
    await settle();
    expect(api.named('decide')[1]?.args).toEqual([
      second.id,
      { action: 'reject', reason: 'speech', revision: 1 },
    ]);
    expect(field('status').textContent).toBe(
      'Rejected (speech): Long talk. Nothing waiting for review.',
    );
  });

  it('keeps an item when its decision fails, and reloads', async () => {
    const api = new FakeCommunity();
    api.me_ = { handle: 'boss', maintainer: true };
    api.queueItems = [queueItem('One')];
    const { root, field, ready } = mount(api);
    await ready;
    api.fail.set(
      'decide',
      new CommunityError(
        'rejected',
        'The share is listed; it cannot be decided that way.',
        'conflict',
      ),
    );
    field<HTMLButtonElement>('list').click();
    await settle();
    expect(root.querySelectorAll('.review-item')).toHaveLength(1);
    expect(field('status').classList.contains('error')).toBe(true);
    expect(field<HTMLButtonElement>('list').disabled).toBe(false);
    api.queueItems = [];
    field<HTMLButtonElement>('reload').click();
    await settle();
    expect(field('status').textContent).toBe('Nothing waiting for review.');
  });

  it('shows what is in the bank and takes a listed sample down with a reason', async () => {
    const api = new FakeCommunity();
    api.me_ = { handle: 'boss', maintainer: true };
    const live = queueItem('Live one', {
      state: 'listed',
      listed_at: '2026-10-21T11:00:00.000Z',
      revision: 3,
    });
    api.queueItems = [live];
    const { root, field, ready } = mount(api);
    await ready;
    expect(field('status').textContent).toBe('Nothing waiting for review.');
    field<HTMLButtonElement>('view-listed').click();
    await settle();
    expect(api.named('queue').map((c) => c.args[0])).toEqual(['pending', 'listed']);
    const item = root.querySelector<HTMLElement>('.review-item') ?? root;
    expect(item.textContent).toContain('listed 2026-10-21 11:00');
    expect(field<HTMLButtonElement>('list', item).hidden).toBe(true);
    const reject = field<HTMLButtonElement>('reject', item);
    expect(reject.textContent).toBe('Take down');
    const reason = field<HTMLSelectElement>('reason', item);
    reason.value = 'hate';
    reason.dispatchEvent(new Event('change'));
    reject.click();
    await settle();
    expect(api.named('decide')[0]?.args).toEqual([
      live.id,
      { action: 'reject', reason: 'hate', revision: 3 },
    ]);
    expect(field('status').textContent).toBe(
      'Taken down (hate): Live one. Nothing in the bank yet.',
    );
  });

  it('shows the recommendation with reasons, notes, scores and a waveform, preselecting nothing', async () => {
    const api = new FakeCommunity();
    api.me_ = { handle: 'boss', maintainer: true };
    api.queueItems = [
      queueItem('Talky', {
        auto: {
          verdict: 'flag:speech',
          checked_at: '2026-10-21T10:00:00.000Z',
          current: true,
          scores: {
            Speech: 0.97,
            Screaming: 0.02,
            peak_dbfs: -6,
            integrated_lufs: -18,
            vad_ratio: 0.9,
          },
          reasons: ['speech: words heard: “call me back”'],
          notes: ['loudness: very loud: -7.0 LUFS'],
          peaks: [0, 0.5, 1, 0.25],
          models: { asr: 'w' },
          policy: 'moderation-v1/1',
        },
      }),
      queueItem('Unchecked'),
    ];
    const { root, field, ready } = mount(api);
    await ready;
    const [first, second] = [...root.querySelectorAll<HTMLElement>('.review-item')];
    if (first === undefined || second === undefined) throw new Error('items');
    expect(field('auto-verdict', first).textContent).toBe('Auto: flagged — speech');
    expect(field('auto-verdict', first).classList.contains('flagged')).toBe(true);
    expect(field('auto-reasons', first).textContent).toContain('call me back');
    expect(field('auto-notes', first).textContent).toBe(
      'borderline · loudness: very loud: -7.0 LUFS',
    );
    expect(field('auto-scores', first).textContent).toBe(
      'peak -6.0 dBFS · -18.0 LUFS · speech 90 % · Speech 0.97, Screaming 0.02',
    );
    expect(field('wave', first).querySelectorAll('rect')).toHaveLength(4);
    expect(field<HTMLSelectElement>('reason', first).value).toBe('');
    expect(field('auto-verdict', second).textContent).toBe('Auto: not checked yet');
    expect(second.querySelector('[data-field="wave"]')).toBeNull();
  });

  it('words outdated and fine recommendations', () => {
    const auto = {
      verdict: 'ok',
      checked_at: 'x',
      current: false,
      scores: {},
      reasons: [],
      notes: [],
      peaks: [],
      models: {},
      policy: '',
    };
    expect(autoSummary(auto).text).toBe('Auto: outdated (changed since the check; was looks fine)');
    expect(autoSummary({ ...auto, current: true }).text).toBe('Auto: looks fine');
    expect(
      topScores({ a: 0.1, b: 0.9, c: 0.5, d: 0.2, e: 0.3, f: 0.4, peak_dbfs: -3, words: 1 }),
    ).toEqual([
      ['b', 0.9],
      ['c', 0.5],
      ['f', 0.4],
      ['e', 0.3],
      ['d', 0.2],
    ]);
  });

  it('shows reported samples with their reasons; Keep dismisses, an appeal is marked', async () => {
    const api = new FakeCommunity();
    api.me_ = { handle: 'boss', maintainer: true };
    const reported = queueItem('Reported one', {
      state: 'listed',
      listed_at: '2026-10-21T11:00:00.000Z',
      revision: 4,
      reports: { open: 3, reasons: { violence: 2, hate: 1 } },
    });
    const appealed = queueItem('Appealed', { appeal: { at: 'x', of: 'speech' } });
    api.queueItems = [reported, appealed];
    const { root, field, ready } = mount(api);
    await ready;
    expect(field('appeal').textContent).toBe('Review requested after: speech');
    expect(field<HTMLButtonElement>('dismiss').hidden).toBe(true);
    field<HTMLButtonElement>('view-reported').click();
    await settle();
    expect(api.named('queue').map((c) => c.args[0])).toEqual(['pending', 'reported']);
    expect(field('status').textContent).toBe(
      '1 reported, oldest report first. Keep it or take it down with a reason.',
    );
    const item = root.querySelector<HTMLElement>('.review-item') ?? root;
    expect(field('reports', item).textContent).toBe('Reported 3×: violence or distress 2, hate 1');
    const keep = field<HTMLButtonElement>('dismiss', item);
    expect(keep.hidden).toBe(false);
    keep.click();
    await settle();
    expect(api.named('decide')[0]?.args).toEqual([reported.id, { action: 'dismiss', revision: 4 }]);
    expect(field('status').textContent).toBe(
      'Kept, reports closed: Reported one. No open reports.',
    );
  });

  it('deletes for good only on a second click within the confirmation time', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const api = new FakeCommunity();
      api.me_ = { handle: 'boss', maintainer: true };
      const doomed = queueItem('Doomed');
      api.queueItems = [doomed];
      const { root, field, ready } = mount(api);
      await ready;
      const remove = field<HTMLButtonElement>('delete');
      remove.click();
      expect(remove.textContent).toBe('Confirm delete');
      expect(api.named('hardDelete')).toHaveLength(0);
      vi.advanceTimersByTime(CONFIRM_MS + 10);
      expect(remove.textContent).toBe('Delete for good');
      remove.click();
      remove.click();
      await settle();
      expect(api.named('hardDelete').map((c) => c.args[0])).toEqual([doomed.id]);
      expect(root.querySelectorAll('.review-item')).toHaveLength(0);
      expect(field('status').textContent).toBe(
        'Deleted for good: Doomed. Nothing waiting for review.',
      );
    } finally {
      vi.useRealTimers();
    }
  });
});
