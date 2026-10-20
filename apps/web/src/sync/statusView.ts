/** The small sync status in the saved-progressions header (docs/specs/sync-v1.md, "Status"). */
import { h, replaceChildren } from '../dom';
import type { SyncEngine, SyncStatus } from './engine';

export function syncLabel(status: SyncStatus): string {
  switch (status.state) {
    case 'synced':
      return 'Synced';
    case 'pending':
      return status.pending > 0 ? `Syncing… (${status.pending})` : 'Syncing…';
    case 'offline':
      return status.pending > 0 ? `Offline (${status.pending})` : 'Offline';
    case 'error':
      return 'Sync error';
    case 'signed-out':
      return 'Sign in';
  }
}

export interface SyncStatusOptions {
  /** What "Sign in" does; reloading lets Access run its login flow. */
  signIn?: () => void;
}

/** A status element that follows the engine; returns the element. */
export function syncStatusView(engine: SyncEngine, options: SyncStatusOptions = {}): HTMLElement {
  const signIn = options.signIn ?? (() => window.location.reload());
  const root = h('span', { attrs: { role: 'status', 'aria-live': 'polite' } });
  const render = (status: SyncStatus): void => {
    root.className = `sync-status sync-${status.state}`;
    if (status.message !== null) root.title = status.message;
    else root.removeAttribute('title');
    if (status.state === 'signed-out') {
      const button = h('button', { props: { type: 'button' } }, syncLabel(status));
      button.onclick = signIn;
      replaceChildren(root, button);
    } else {
      replaceChildren(root, syncLabel(status));
    }
  };
  render(engine.status);
  engine.subscribe(render);
  return root;
}
