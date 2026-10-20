/**
 * The review queue (docs/specs/community-v1.md §4.5): every pending share, oldest first, with a
 * player that never starts by itself, List, and Reject with a category; a second view lists what
 * is in the bank, for a take-down. Only the maintainer sees it; a decided item leaves the list.
 * A decision names the revision shown, so a share renamed meanwhile is refused. Nothing here
 * decides on its own.
 */
import { h, option } from '../dom';
import type { CommunityClient, QueueItem } from '../sync/community';
import { REJECT_LABELS, REJECT_REASONS, communityMessage } from '../sync/community';

function size(bytes: number): string {
  return bytes < 1024 * 1024
    ? `${Math.ceil(bytes / 1024)} KB`
    : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function day(iso: string): string {
  return iso.slice(0, 16).replace('T', ' ');
}

/** One queue item with its player and decision buttons (a listed one: Take down only). */
function itemView(
  item: QueueItem,
  client: CommunityClient,
  done: (message: string) => void,
  failed: (message: string) => void,
): HTMLElement {
  const player = h('audio', {
    props: { controls: true, preload: 'none', src: client.sampleUrl(item.id) },
    attrs: { 'aria-label': `Listen to ${item.name}`, 'data-field': 'player' },
  });
  const listed = item.state === 'listed';
  const list = h(
    'button',
    {
      class: 'primary',
      props: { type: 'button', hidden: listed },
      attrs: { 'data-field': 'list' },
    },
    'List',
  );
  const reason = h(
    'select',
    { attrs: { 'aria-label': 'Reason for a rejection', 'data-field': 'reason' } },
    option('', 'Reason…', true),
    ...REJECT_REASONS.map((r) => option(r, REJECT_LABELS[r])),
  );
  const reject = h(
    'button',
    {
      class: 'danger',
      props: { type: 'button', disabled: true },
      attrs: { title: 'Pick a reason first; the owner sees it', 'data-field': 'reject' },
    },
    listed ? 'Take down' : 'Reject',
  );
  reason.onchange = () => {
    reject.disabled = reason.value === '';
  };
  const buttons = [list, reason, reject];
  const decide = (decision: Parameters<CommunityClient['decide']>[1], verb: string): void => {
    for (const b of buttons) b.disabled = true;
    if (!player.paused) player.pause();
    client.decide(item.id, decision).then(
      () => done(`${verb}: ${item.name}`),
      (e: unknown) => {
        list.disabled = false;
        reason.disabled = false;
        reject.disabled = reason.value === '';
        failed(communityMessage(e));
      },
    );
  };
  const revision = item.revision;
  list.onclick = () => decide({ action: 'list', revision }, 'Listed');
  reject.onclick = () => {
    const picked = REJECT_REASONS.find((r) => r === reason.value);
    if (picked !== undefined) {
      const verb = listed ? 'Taken down' : 'Rejected';
      decide({ action: 'reject', reason: picked, revision }, `${verb} (${REJECT_LABELS[picked]})`);
    }
  };
  return h(
    'li',
    { class: 'review-item', attrs: { 'data-id': item.id } },
    h(
      'span',
      { class: 'review-meta' },
      h('strong', { attrs: { title: item.name } }, item.name),
      h(
        'span',
        {},
        `by ${item.owner} · ${item.duration.toFixed(2)} s · ${item.channels === 2 ? 'stereo' : 'mono'} · ${size(item.bytes)} · root ${item.root}`,
      ),
      h(
        'span',
        {},
        `${listed && item.listed_at !== null ? `listed ${day(item.listed_at)}` : `shared ${day(item.shared_at)}`}${item.tags.length > 0 ? ` · ${item.tags.join(', ')}` : ''}`,
      ),
    ),
    h('span', { class: 'review-actions' }, list, reason, reject),
    player,
  );
}

/** Fill `root` with the queue; resolves once the first answer is shown. */
export async function mountReview(root: HTMLElement, client: CommunityClient): Promise<void> {
  const status = h('p', {
    class: 'review-status',
    attrs: { role: 'status', 'data-field': 'status' },
  });
  const list = h('ul', { class: 'review-list', attrs: { 'data-field': 'queue' } });
  const reload = h(
    'button',
    { props: { type: 'button' }, attrs: { 'data-field': 'reload' } },
    'Reload',
  );
  let view: 'pending' | 'listed' = 'pending';
  const viewButton = (name: 'pending' | 'listed', label: string): HTMLButtonElement => {
    const button = h(
      'button',
      {
        class: 'sampler-tab',
        props: { type: 'button' },
        attrs: { role: 'tab', 'data-field': `view-${name}` },
      },
      label,
    );
    button.onclick = () => {
      view = name;
      void load();
    };
    return button;
  };
  const views = {
    pending: viewButton('pending', 'Waiting for review'),
    listed: viewButton('listed', 'In the bank'),
  };
  const tabs = h(
    'p',
    { class: 'review-tabs', attrs: { role: 'tablist' } },
    views.pending,
    views.listed,
  );
  root.replaceChildren(
    h('h1', {}, 'Review queue'),
    h(
      'p',
      { class: 'review-note' },
      'Every share waits here until you list or reject it. Nothing is listed, rejected or deleted ' +
        'automatically. Listen before you decide; players never start by themselves.',
    ),
    tabs,
    status,
    list,
    reload,
  );
  const say = (message: string, error = false): void => {
    status.textContent = message;
    status.classList.toggle('error', error);
  };
  const empty = (): string =>
    view === 'pending' ? 'Nothing waiting for review.' : 'Nothing in the bank yet.';
  let request = 0;
  const load = async (): Promise<void> => {
    const mine = ++request;
    for (const [name, button] of Object.entries(views)) {
      button.classList.toggle('active', name === view);
      button.setAttribute('aria-selected', String(name === view));
    }
    say('Loading…');
    try {
      const items = await client.queue(view);
      if (mine !== request) return;
      list.replaceChildren(
        ...items.map((item) => {
          const el = itemView(
            item,
            client,
            (message) => {
              el.remove();
              say(list.children.length === 0 ? `${message}. ${empty()}` : message);
            },
            (message) => say(message, true),
          );
          return el;
        }),
      );
      if (items.length === 0) say(empty());
      else if (view === 'pending') say(`${items.length} waiting for review, oldest first.`);
      else say(`${items.length} in the bank, newest first. Take one down with a reason.`);
    } catch (e) {
      if (mine === request) say(communityMessage(e), true);
    }
  };
  reload.onclick = () => void load();
  let me: { maintainer: boolean } | null = null;
  try {
    me = await client.me();
  } catch (e) {
    say(communityMessage(e), true);
    reload.hidden = true;
    tabs.hidden = true;
    return;
  }
  if (!me.maintainer) {
    say('This page is for the maintainer.');
    reload.hidden = true;
    tabs.hidden = true;
    return;
  }
  await load();
}
