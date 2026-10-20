/** The maintainer's review queue page (docs/specs/community-v1.md §4.5) against the fake bank. */
import { afterEach, describe, expect, it } from 'vitest';
import { mountReview } from '../src/review/queue';
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
    expect(api.named('decide')[0]?.args).toEqual([first.id, { action: 'list' }]);
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
      { action: 'reject', reason: 'speech' },
    ]);
    expect(field('status').textContent).toBe('Rejected (speech): Long talk. Nothing else waiting.');
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
});
