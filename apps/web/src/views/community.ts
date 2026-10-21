/**
 * The community parts of the Sampler panel (docs/specs/community-v1.md §4.3–§4.4): the Share
 * toggle with its licence form and status, and the Community tab (search, tags, audition through
 * the sampler voice, Add to slot, the handle, Your shares, Report and Request review of
 * docs/specs/moderation-v1.md §5.2). Only built when sync is on; every request goes through
 * `CommunitySync` and its client.
 */
import type { SamplerId } from '../audio/instruments';
import { samplerSlot } from '../audio/instruments';
import type { AuditionHandle, Samplers } from '../audio/sampler';
import { h, option } from '../dom';
import type { CommunitySample, OwnSample, Share } from '../sync/community';
import {
  LICENCE_TEXT,
  REJECT_LABELS,
  REPORT_REASONS,
  communityMessage,
  rejectLabel,
} from '../sync/community';
import type { CommunitySync } from '../sync/communitySync';

export interface CommunityDeps {
  sync: CommunitySync;
  samplers: Samplers;
}

/** Status text and tooltip of a share for its owner. */
export function shareStatus(share: Share | null): { text: string; title: string } {
  switch (share?.state) {
    case 'pending':
      return share.appealed_at !== null
        ? { text: 'Checking… (review requested)', title: 'The maintainer looks at it again' }
        : { text: 'Checking…', title: 'Waiting for the maintainer to listen to it' };
    case 'listed':
      return { text: 'Shared', title: 'In the community bank' };
    case 'unlisted':
      return { text: 'Not shared', title: 'Unshared: whoever already has it keeps it' };
    case 'rejected':
      return {
        text: `Not listed: ${rejectLabel(share.reason)}`,
        title: 'The maintainer did not accept it for the community bank',
      };
    default:
      return { text: '', title: '' };
  }
}

/** `"drums, kick  808"` → `['drums', 'kick', '808']` (lower case, unique, at most 5). */
export function parseTags(text: string): string[] {
  const tags = text
    .toLowerCase()
    .split(/[\s,]+/)
    .map((t) => t.replace(/[^a-z0-9-]/g, '').slice(0, 16))
    .filter((t) => t !== '');
  return [...new Set(tags)].slice(0, 5);
}

/** "0.4 s", "12 s". */
function lengthLabel(seconds: number): string {
  return seconds < 10 ? `${seconds.toFixed(1)} s` : `${Math.round(seconds)} s`;
}

export interface CommunityViews {
  /** The Share toggle and its status, for the panel head. */
  shareBar: HTMLElement;
  /** The licence form, under the head while open. */
  shareForm: HTMLElement;
  /** The Community tab's body. */
  tab: HTMLElement;
  /** Bring the share bar up to date with `slot` (cheap). */
  update(slot: SamplerId | null): void;
  /** The Community tab became visible (loads the first page once, the own shares each time). */
  opened(): void;
  /** Ask the server for the own shares again on the next update (another slot was shown). */
  refresh(): void;
}

export function createCommunityViews(
  deps: CommunityDeps,
  options: { slot(): SamplerId | null; taken(): void },
): CommunityViews {
  const { sync, samplers } = deps;
  const client = sync.client;
  let mine: OwnSample[] | null = null;
  let loadingMine: Promise<void> | null = null;
  /** The own list was asked for since the last refresh (a failure is not retried per edit). */
  let mineTried = false;
  let slot: SamplerId | null = null;

  const loadMine = (): Promise<void> => {
    mineTried = true;
    loadingMine ??= client.mine().then(
      (list) => {
        mine = list;
        loadingMine = null;
        render();
      },
      (e: unknown) => {
        loadingMine = null;
        showStatus(communityMessage(e), true);
      },
    );
    return loadingMine;
  };
  const putMine = (sample: OwnSample): void => {
    mine = [sample, ...(mine ?? []).filter((s) => s.id !== sample.id)];
    render();
  };

  // Share bar and form --------------------------------------------------------------------
  const toggle = h('input', {
    props: { type: 'checkbox' },
    attrs: { 'aria-label': 'Share in the community bank', 'data-field': 'share' },
  });
  const status = h('span', { class: 'share-status', attrs: { 'data-field': 'share-status' } });
  const shareBar = h(
    'span',
    { class: 'share-bar' },
    h('label', { class: 'sampler-check' }, toggle, 'Share'),
    status,
  );
  const nameInput = h('input', {
    props: { type: 'text', maxLength: 64, spellcheck: false },
    attrs: { 'aria-label': 'Name in the community bank', 'data-field': 'share-name' },
  });
  const tagsInput = h('input', {
    props: { type: 'text', maxLength: 100, spellcheck: false, placeholder: 'drums, kick' },
    attrs: { 'aria-label': 'Tags (up to 5)', 'data-field': 'share-tags' },
  });
  const licence = h('input', {
    props: { type: 'checkbox' },
    attrs: { 'data-field': 'share-licence' },
  });
  const submit = h(
    'button',
    {
      class: 'primary',
      props: { type: 'submit', disabled: true },
      attrs: { 'data-field': 'share-submit' },
    },
    'Share',
  );
  const cancel = h(
    'button',
    { props: { type: 'button' }, attrs: { 'data-field': 'share-cancel' } },
    'Cancel',
  );
  const formError = h('p', {
    class: 'sampler-error',
    props: { hidden: true },
    attrs: { role: 'status', 'data-field': 'share-error' },
  });
  const shareForm = h(
    'form',
    { class: 'share-form', props: { hidden: true }, attrs: { 'data-field': 'share-form' } },
    h('label', { class: 'sampler-select' }, h('span', {}, 'Name'), nameInput),
    h('label', { class: 'sampler-select' }, h('span', {}, 'Tags'), tagsInput),
    h('label', { class: 'share-licence' }, licence, h('span', {}, LICENCE_TEXT)),
    h('p', { class: 'share-note' }, 'The maintainer listens to every share before it is listed.'),
    h('span', { class: 'share-actions' }, submit, cancel),
    formError,
  );
  let busy = false;
  const ownRemote = (): string | null => {
    const sample = slot === null ? null : samplers.patch(slot).sample;
    if (sample == null || sample.remote?.community === true) return null;
    return sample.remote?.id ?? null;
  };
  const currentShare = (): Share | null => {
    const remote = ownRemote();
    return remote === null ? null : (mine?.find((s) => s.id === remote)?.share ?? null);
  };
  let note: string | null = null;
  const closeForm = (): void => {
    shareForm.hidden = true;
    formError.hidden = true;
    render();
  };
  licence.onchange = () => {
    submit.disabled = busy || !licence.checked;
  };
  toggle.onchange = () => {
    note = null;
    if (toggle.checked) {
      const sample = slot === null ? null : samplers.patch(slot).sample;
      nameInput.value = (sample?.name ?? '').replace(/\.[a-z0-9]+$/i, '').slice(0, 64);
      tagsInput.value = '';
      licence.checked = false;
      submit.disabled = true;
      formError.hidden = true;
      shareForm.hidden = false;
      nameInput.focus();
      render();
      return;
    }
    if (!shareForm.hidden) {
      closeForm();
      return;
    }
    const remote = ownRemote();
    if (remote === null) return;
    busy = true;
    render();
    client.unshare(remote).then(
      (sample) => {
        busy = false;
        note = 'Unshared: who already has it keeps it.';
        putMine(sample);
      },
      (e: unknown) => {
        busy = false;
        note = communityMessage(e);
        render();
      },
    );
  };
  cancel.onclick = () => closeForm();
  shareForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const target = slot;
    if (target === null || !licence.checked || busy) return;
    busy = true;
    submit.disabled = true;
    formError.hidden = true;
    status.textContent = 'Sharing…';
    sync
      .share(target, {
        name: nameInput.value.trim() === '' ? 'Sample' : nameInput.value.trim(),
        tags: parseTags(tagsInput.value),
      })
      .then(
        (sample) => {
          busy = false;
          shareForm.hidden = true;
          putMine(sample);
        },
        (e: unknown) => {
          busy = false;
          submit.disabled = !licence.checked;
          formError.textContent = communityMessage(e);
          formError.hidden = false;
          render();
        },
      );
  });

  const renderShare = (): void => {
    const sample = slot === null ? null : samplers.patch(slot).sample;
    const own = sample != null && sample.remote?.community !== true;
    shareBar.hidden = !own;
    if (!own) {
      shareForm.hidden = true;
      return;
    }
    const share = currentShare();
    const live = share?.state === 'pending' || share?.state === 'listed';
    toggle.checked = !shareForm.hidden || live;
    toggle.disabled = busy || share?.state === 'rejected';
    const { text, title } = shareStatus(share);
    status.textContent = busy ? '…' : (note ?? text);
    status.title = title;
    status.classList.toggle('rejected', share?.state === 'rejected');
  };

  // Community tab --------------------------------------------------------------------------
  const tabStatus = h('p', {
    class: 'community-status',
    props: { hidden: true },
    attrs: { role: 'status', 'data-field': 'community-status' },
  });
  const showStatus = (message: string | null, error = false): void => {
    tabStatus.textContent = message ?? '';
    tabStatus.hidden = message === null;
    tabStatus.classList.toggle('error', error);
  };
  const handleText = h('strong', { attrs: { 'data-field': 'handle' } }, '…');
  const handleInput = h('input', {
    props: {
      type: 'text',
      maxLength: 24,
      spellcheck: false,
      hidden: true,
      placeholder: 'your name',
    },
    attrs: { 'aria-label': 'Your name in the community bank', 'data-field': 'handle-input' },
  });
  const handleButton = h(
    'button',
    { props: { type: 'button' }, attrs: { 'data-field': 'handle-edit' } },
    'Change',
  );
  let editingHandle = false;
  handleButton.onclick = () => {
    if (!editingHandle) {
      editingHandle = true;
      handleInput.value = handleText.textContent ?? '';
      handleInput.hidden = false;
      handleText.hidden = true;
      handleButton.textContent = 'Save';
      handleInput.focus();
      return;
    }
    const value = handleInput.value.trim();
    client.setHandle(value === '' ? null : value).then(
      (handle) => {
        editingHandle = false;
        handleText.textContent = handle;
        handleText.hidden = false;
        handleInput.hidden = true;
        handleButton.textContent = 'Change';
        showStatus(null);
      },
      (e: unknown) => showStatus(communityMessage(e), true),
    );
  };
  const search = h('input', {
    props: { type: 'search', maxLength: 64, placeholder: 'Search names' },
    attrs: { 'aria-label': 'Search the community bank', 'data-field': 'community-search' },
  });
  const tagFilter = h('input', {
    props: { type: 'search', maxLength: 16, placeholder: 'tag' },
    attrs: { 'aria-label': 'Filter by tag', 'data-field': 'community-tag' },
  });
  const searchForm = h(
    'form',
    { class: 'community-search' },
    search,
    tagFilter,
    h('button', { props: { type: 'submit' }, attrs: { 'data-field': 'community-go' } }, 'Search'),
  );
  const list = h('ul', {
    class: 'community-list',
    attrs: { 'aria-label': 'Community samples', 'data-field': 'community-list' },
  });
  const more = h(
    'button',
    { props: { type: 'button', hidden: true }, attrs: { 'data-field': 'more' } },
    'More',
  );
  const mineList = h('ul', {
    class: 'community-list mine',
    attrs: { 'aria-label': 'Your samples on the server', 'data-field': 'mine' },
  });
  const mineBox = h(
    'section',
    { class: 'community-mine' },
    h('h4', {}, 'Your samples on the server'),
    mineList,
  );
  const tab = h(
    'div',
    { class: 'community-tab', props: { hidden: true }, attrs: { 'data-field': 'community' } },
    h('p', { class: 'community-me' }, 'You appear as ', handleText, handleInput, ' ', handleButton),
    searchForm,
    tabStatus,
    list,
    more,
    mineBox,
  );

  let results: CommunitySample[] = [];
  let next: string | null = null;
  let loaded = false;
  let query = { q: '', tag: '' };
  /** Bumped per request, so an older answer (a slow page, a previous search) never lands. */
  let request = 0;
  const browse = (append: boolean): void => {
    const mine = ++request;
    more.disabled = true;
    showStatus('Loading…');
    client.browse({ q: query.q, tag: query.tag, cursor: append ? next : null }).then(
      (page) => {
        if (mine !== request) return;
        results = append ? [...results, ...page.samples] : page.samples;
        next = page.next;
        more.disabled = false;
        showStatus(results.length === 0 ? 'Nothing here yet.' : null);
        renderList();
      },
      (e: unknown) => {
        if (mine !== request) return;
        more.disabled = false;
        showStatus(communityMessage(e), true);
      },
    );
  };
  searchForm.addEventListener('submit', (event) => {
    event.preventDefault();
    query = { q: search.value, tag: parseTags(tagFilter.value)[0] ?? '' };
    tagFilter.value = query.tag;
    browse(false);
  });
  more.onclick = () => browse(true);

  /** Press and hold to hear a sample at its root; the first press downloads it. */
  const auditionButton = (sample: CommunitySample): HTMLButtonElement => {
    const button = h(
      'button',
      {
        class: 'icon community-play',
        props: { type: 'button' },
        attrs: {
          title: 'Hold to listen',
          'aria-label': `Listen to ${sample.name}`,
          'data-field': 'audition',
        },
      },
      '▶',
    );
    let handle: AuditionHandle | null = null;
    let held = false;
    button.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      button.setPointerCapture?.(event.pointerId);
      held = true;
      button.classList.add('down');
      samplers
        .preview(sample.id, () => client.bytes(sample.id), sample.root)
        .then(
          (h) => {
            if (held) handle = h;
            else h?.release();
          },
          (e: unknown) => showStatus(`Could not play ${sample.name}: ${communityMessage(e)}`, true),
        );
    });
    const up = (): void => {
      held = false;
      button.classList.remove('down');
      handle?.release();
      handle = null;
    };
    button.addEventListener('pointerup', up);
    button.addEventListener('pointercancel', up);
    button.addEventListener('lostpointercapture', up);
    return button;
  };

  /** Samples this browser reported (the item then thanks instead of offering Report again). */
  const reported = new Set<string>();

  /** Report → a reason (no default) with Send report and Cancel; the sample stays listed. */
  const reportControl = (sample: CommunitySample): HTMLElement => {
    const box = h('span', { class: 'community-report', attrs: { 'data-field': 'report-box' } });
    const thanks = (): void => {
      box.replaceChildren(h('span', { class: 'share-status' }, 'Reported, thank you'));
    };
    if (reported.has(sample.id)) {
      thanks();
      return box;
    }
    const open = h(
      'button',
      {
        props: { type: 'button' },
        attrs: { title: 'Tell the maintainer something is wrong with it', 'data-field': 'report' },
      },
      'Report',
    );
    const reason = h(
      'select',
      { attrs: { 'aria-label': 'What is wrong with it', 'data-field': 'report-reason' } },
      option('', 'Reason…', true),
      ...REPORT_REASONS.map((r) => option(r, REJECT_LABELS[r])),
    );
    const send = h(
      'button',
      {
        class: 'danger',
        props: { type: 'button', disabled: true },
        attrs: { 'data-field': 'report-send' },
      },
      'Send report',
    );
    const cancel = h(
      'button',
      { props: { type: 'button' }, attrs: { 'data-field': 'report-cancel' } },
      'Cancel',
    );
    reason.onchange = () => {
      send.disabled = reason.value === '';
    };
    open.onclick = () => box.replaceChildren(reason, send, cancel);
    cancel.onclick = () => {
      reason.value = '';
      send.disabled = true;
      box.replaceChildren(open);
    };
    send.onclick = () => {
      const picked = REPORT_REASONS.find((r) => r === reason.value);
      if (picked === undefined) return;
      send.disabled = true;
      client.report(sample.id, picked).then(
        () => {
          reported.add(sample.id);
          thanks();
          showStatus(null);
        },
        (e: unknown) => {
          send.disabled = false;
          showStatus(communityMessage(e), true);
        },
      );
    };
    box.append(open);
    return box;
  };

  const renderList = (): void => {
    const target = options.slot();
    list.replaceChildren(
      ...results.map((sample) => {
        const add = h(
          'button',
          { props: { type: 'button', disabled: target === null }, attrs: { 'data-field': 'add' } },
          target === null ? 'Add' : `Add to slot ${samplerSlot(target)}`,
        );
        add.onclick = () => {
          const into = options.slot();
          if (into === null) return;
          add.disabled = true;
          showStatus(`Adding ${sample.name}…`);
          sync.take(into, sample).then(
            () => {
              showStatus(null);
              options.taken();
            },
            (e: unknown) => {
              add.disabled = false;
              showStatus(communityMessage(e), true);
            },
          );
        };
        return h(
          'li',
          { class: 'community-item', attrs: { 'data-id': sample.id } },
          auditionButton(sample),
          h(
            'span',
            { class: 'community-main' },
            h('span', { class: 'community-name', attrs: { title: sample.name } }, sample.name),
            h('span', { class: 'community-by' }, sample.own ? 'by you' : `by ${sample.owner}`),
            h(
              'span',
              { class: 'community-tags' },
              ...sample.tags.map((tag) => {
                const chip = h(
                  'button',
                  { class: 'tag', props: { type: 'button' }, attrs: { 'data-tag': tag } },
                  tag,
                );
                chip.onclick = () => {
                  tagFilter.value = tag;
                  query = { q: search.value, tag };
                  browse(false);
                };
                return chip;
              }),
            ),
          ),
          h('span', { class: 'sampler-value' }, lengthLabel(sample.duration)),
          add,
          ...(sample.own ? [] : [reportControl(sample)]),
        );
      }),
    );
    more.hidden = next === null;
  };

  /**
   * The own uploads that are shared or in no slot: their state, Unshare for a live share, Delete
   * for one that no slot uses and that is not shared (frees the quota; the server keeps it while
   * someone else has it).
   */
  const renderMine = (): void => {
    const shown = (mine ?? []).filter((s) => s.share !== null || !sync.inUse(s.id));
    mineBox.hidden = shown.length === 0;
    mineList.replaceChildren(
      ...shown.map((sample) => {
        const shared = shareStatus(sample.share);
        const used = sync.inUse(sample.id);
        const live = sample.share?.state === 'pending' || sample.share?.state === 'listed';
        const text = shared.text !== '' ? shared.text : used ? '' : 'In no slot';
        const unshare = h(
          'button',
          { props: { type: 'button', hidden: !live }, attrs: { 'data-field': 'unshare' } },
          'Unshare',
        );
        unshare.onclick = () => {
          unshare.disabled = true;
          client.unshare(sample.id).then(putMine, (e: unknown) => {
            unshare.disabled = false;
            showStatus(communityMessage(e), true);
          });
        };
        const remove = h(
          'button',
          {
            class: 'danger',
            props: { type: 'button', hidden: live || used },
            attrs: {
              title: 'Delete it from the server (whoever already has it keeps it)',
              'data-field': 'delete',
            },
          },
          'Delete',
        );
        remove.onclick = () => {
          remove.disabled = true;
          client.remove(sample.id).then(
            () => {
              mine = (mine ?? []).filter((s) => s.id !== sample.id);
              render();
            },
            (e: unknown) => {
              remove.disabled = false;
              showStatus(communityMessage(e), true);
            },
          );
        };
        const canAppeal = sample.share?.state === 'rejected' && sample.share.appealed_at === null;
        const appeal = h(
          'button',
          {
            props: { type: 'button', hidden: !canAppeal },
            attrs: {
              title: 'Ask the maintainer to listen to it again (once)',
              'data-field': 'appeal',
            },
          },
          'Request review',
        );
        appeal.onclick = () => {
          appeal.disabled = true;
          client.appeal(sample.id).then(putMine, (e: unknown) => {
            appeal.disabled = false;
            showStatus(communityMessage(e), true);
          });
        };
        return h(
          'li',
          { class: 'community-item', attrs: { 'data-id': sample.id } },
          h(
            'span',
            { class: 'community-main' },
            h('span', { class: 'community-name' }, sample.name),
            h('span', { class: 'share-status', attrs: { title: shared.title } }, text),
          ),
          appeal,
          unshare,
          remove,
        );
      }),
    );
  };

  function render(): void {
    renderShare();
    renderMine();
  }

  return {
    shareBar,
    shareForm,
    tab,
    update(next) {
      if (next !== slot) {
        note = null;
        shareForm.hidden = true;
      }
      slot = next;
      if (!mineTried) void loadMine();
      renderShare();
      if (loaded) renderList();
    },
    opened() {
      void loadMine();
      if (loaded) return;
      loaded = true;
      browse(false);
      client.me().then(
        (me) => {
          handleText.textContent = me.handle;
        },
        () => undefined,
      );
    },
    refresh() {
      mineTried = false;
    },
  };
}
