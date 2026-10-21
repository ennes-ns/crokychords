/**
 * The review queue (docs/specs/community-v1.md §4.5, docs/specs/moderation-v1.md §5.1): every
 * pending share, oldest first, with a player that never starts by itself, the automatic checks'
 * recommendation (verdict, reasons, scores, a waveform drawn from peaks), List, and Reject with a
 * category; a Reported view for listed samples with open reports (Keep or Take down); a view of
 * what is in the bank; and a two-step hard delete. Only the maintainer sees it; a decided item
 * leaves the list. A decision names the revision shown, so a share renamed meanwhile is refused.
 * Nothing here decides on its own, and the recommendation never preselects anything.
 */
import { h, option } from '../dom';
import type { AutoVerdict, CommunityClient, QueueItem, QueueView } from '../sync/community';
import { REJECT_LABELS, REJECT_REASONS, communityMessage, rejectLabel } from '../sync/community';

function size(bytes: number): string {
  return bytes < 1024 * 1024
    ? `${Math.ceil(bytes / 1024)} KB`
    : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function day(iso: string): string {
  return iso.slice(0, 16).replace('T', ' ');
}

/** How long the armed "Confirm delete" stays armed. */
export const CONFIRM_MS = 5000;

const SVG = 'http://www.w3.org/2000/svg';

/** A bar waveform of `peaks` (0–1) as inline SVG; nothing is downloaded or played. */
export function waveform(peaks: readonly number[]): SVGSVGElement {
  const height = 32;
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', `0 0 ${Math.max(1, peaks.length) * 2} ${height}`);
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.setAttribute('class', 'review-wave');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', 'Waveform');
  svg.setAttribute('data-field', 'wave');
  peaks.forEach((peak, i) => {
    const bar = Math.max(1, Math.min(1, peak) * height);
    const rect = document.createElementNS(SVG, 'rect');
    rect.setAttribute('x', String(i * 2));
    rect.setAttribute('y', String((height - bar) / 2));
    rect.setAttribute('width', '1.5');
    rect.setAttribute('height', String(bar));
    svg.append(rect);
  });
  return svg;
}

/** The one-line summary of a recommendation. */
export function autoSummary(auto: AutoVerdict | null): { text: string; flagged: boolean } {
  if (auto === null) return { text: 'Auto: not checked yet', flagged: false };
  const flagged = auto.verdict.startsWith('flag:');
  const what = flagged
    ? `flagged — ${rejectLabel(auto.verdict.slice('flag:'.length))}`
    : 'looks fine';
  return {
    text: auto.current ? `Auto: ${what}` : `Auto: outdated (changed since the check; was ${what})`,
    flagged,
  };
}

const LEVEL_KEYS = /(_s|_dbfs|_dbtp|_lufs|_ratio)$|^words/;

/** The five highest model scores (0–1), without levels, ratios and word counts. */
export function topScores(scores: Record<string, number>, n = 5): [string, number][] {
  return Object.entries(scores)
    .filter(([k, v]) => !LEVEL_KEYS.test(k) && v >= 0 && v <= 1)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n);
}

function levels(scores: Record<string, number>): string {
  const parts: string[] = [];
  const peak = scores['peak_dbfs'];
  const tp = scores['true_peak_dbtp'];
  const lufs = scores['integrated_lufs'];
  const vad = scores['vad_ratio'];
  if (peak !== undefined && peak > -900) parts.push(`peak ${peak.toFixed(1)} dBFS`);
  if (tp !== undefined && tp > -900) parts.push(`true peak ${tp.toFixed(1)} dBTP`);
  if (lufs !== undefined) parts.push(`${lufs.toFixed(1)} LUFS`);
  if (vad !== undefined) parts.push(`speech ${Math.round(vad * 100)} %`);
  return parts.join(' · ');
}

function autoView(item: QueueItem): HTMLElement {
  const { auto } = item;
  const summary = autoSummary(auto);
  const box = h(
    'div',
    { class: 'review-auto', attrs: { 'data-field': 'auto' } },
    h(
      'strong',
      { class: summary.flagged ? 'flagged' : '', attrs: { 'data-field': 'auto-verdict' } },
      summary.text,
    ),
  );
  if (auto === null) return box;
  if (auto.reasons.length > 0) {
    box.append(
      h(
        'ul',
        { class: 'review-reasons', attrs: { 'data-field': 'auto-reasons' } },
        ...auto.reasons.map((r) => h('li', {}, r)),
      ),
    );
  }
  if (auto.notes.length > 0) {
    box.append(
      h(
        'ul',
        { class: 'review-notes', attrs: { 'data-field': 'auto-notes' } },
        ...auto.notes.map((r) => h('li', {}, `borderline · ${r}`)),
      ),
    );
  }
  const line = [
    levels(auto.scores),
    topScores(auto.scores)
      .map(([k, v]) => `${k} ${v.toFixed(2)}`)
      .join(', '),
  ].filter((p) => p !== '');
  if (line.length > 0) {
    box.append(
      h(
        'span',
        { class: 'review-scores', attrs: { 'data-field': 'auto-scores' } },
        line.join(' · '),
      ),
    );
  }
  if (auto.peaks.length > 0) box.append(waveform(auto.peaks));
  return box;
}

/** One queue item with its player, recommendation and decision buttons. */
function itemView(
  item: QueueItem,
  view: QueueView,
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
  const keep = h(
    'button',
    {
      props: { type: 'button', hidden: view !== 'reported' },
      attrs: { title: 'Keep it in the bank and close the reports', 'data-field': 'dismiss' },
    },
    'Keep (dismiss reports)',
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
  const remove = h(
    'button',
    {
      class: 'danger',
      props: { type: 'button' },
      attrs: {
        title: 'Delete the file for good (refused while someone else uses it)',
        'data-field': 'delete',
      },
    },
    'Delete for good',
  );
  reason.onchange = () => {
    reject.disabled = reason.value === '';
  };
  const buttons = [list, keep, reason, reject, remove];
  const settle = (e: unknown): void => {
    for (const b of buttons) b.disabled = false;
    reject.disabled = reason.value === '';
    failed(communityMessage(e));
  };
  const busy = (): void => {
    for (const b of buttons) b.disabled = true;
    if (!player.paused) player.pause();
  };
  const decide = (decision: Parameters<CommunityClient['decide']>[1], verb: string): void => {
    busy();
    client.decide(item.id, decision).then(() => done(`${verb}: ${item.name}`), settle);
  };
  const revision = item.revision;
  list.onclick = () => decide({ action: 'list', revision }, 'Listed');
  keep.onclick = () => decide({ action: 'dismiss', revision }, 'Kept, reports closed');
  reject.onclick = () => {
    const picked = REJECT_REASONS.find((r) => r === reason.value);
    if (picked !== undefined) {
      const verb = listed ? 'Taken down' : 'Rejected';
      decide({ action: 'reject', reason: picked, revision }, `${verb} (${REJECT_LABELS[picked]})`);
    }
  };
  let armed: ReturnType<typeof setTimeout> | null = null;
  const disarm = (): void => {
    if (armed !== null) clearTimeout(armed);
    armed = null;
    remove.textContent = 'Delete for good';
    remove.classList.remove('armed');
  };
  remove.onclick = () => {
    if (armed === null) {
      remove.textContent = 'Confirm delete';
      remove.classList.add('armed');
      armed = setTimeout(disarm, CONFIRM_MS);
      return;
    }
    disarm();
    busy();
    client.hardDelete(item.id).then(() => done(`Deleted for good: ${item.name}`), settle);
  };
  const extra: HTMLElement[] = [];
  if (item.reports.open > 0) {
    const reasons = Object.entries(item.reports.reasons)
      .map(([r, n]) => `${rejectLabel(r)} ${n}`)
      .join(', ');
    extra.push(
      h(
        'span',
        { class: 'review-reports', attrs: { 'data-field': 'reports' } },
        `Reported ${item.reports.open}×: ${reasons}`,
      ),
    );
  }
  if (item.appeal !== null) {
    extra.push(
      h(
        'span',
        { class: 'review-appeal', attrs: { 'data-field': 'appeal' } },
        `Review requested after: ${rejectLabel(item.appeal.of)}`,
      ),
    );
  }
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
      ...extra,
    ),
    h('span', { class: 'review-actions' }, list, keep, reason, reject, remove),
    autoView(item),
    player,
  );
}

const EMPTY: Record<QueueView, string> = {
  pending: 'Nothing waiting for review.',
  reported: 'No open reports.',
  listed: 'Nothing in the bank yet.',
};

function countLine(view: QueueView, n: number): string {
  switch (view) {
    case 'pending':
      return `${n} waiting for review, oldest first.`;
    case 'reported':
      return `${n} reported, oldest report first. Keep it or take it down with a reason.`;
    case 'listed':
      return `${n} in the bank, newest first. Take one down with a reason.`;
  }
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
  let view: QueueView = 'pending';
  const viewButton = (name: QueueView, label: string): HTMLButtonElement => {
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
  const views: Record<QueueView, HTMLButtonElement> = {
    pending: viewButton('pending', 'Waiting for review'),
    reported: viewButton('reported', 'Reported'),
    listed: viewButton('listed', 'In the bank'),
  };
  const tabs = h(
    'p',
    { class: 'review-tabs', attrs: { role: 'tablist' } },
    views.pending,
    views.reported,
    views.listed,
  );
  root.replaceChildren(
    h('h1', {}, 'Review queue'),
    h(
      'p',
      { class: 'review-note' },
      'Every share waits here until you list or reject it. Nothing is listed, rejected or deleted ' +
        'automatically: the automatic checks only recommend. Listen before you decide; players ' +
        'never start by themselves.',
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
  let request = 0;
  const load = async (): Promise<void> => {
    const mine = ++request;
    const shown = view;
    for (const [name, button] of Object.entries(views)) {
      button.classList.toggle('active', name === view);
      button.setAttribute('aria-selected', String(name === view));
    }
    say('Loading…');
    try {
      const items = await client.queue(shown);
      if (mine !== request) return;
      list.replaceChildren(
        ...items.map((item) => {
          const el = itemView(
            item,
            shown,
            client,
            (message) => {
              el.remove();
              say(list.children.length === 0 ? `${message}. ${EMPTY[shown]}` : message);
            },
            (message) => say(message, true),
          );
          return el;
        }),
      );
      say(items.length === 0 ? EMPTY[shown] : countLine(shown, items.length));
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
