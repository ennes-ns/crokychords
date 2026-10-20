/**
 * The maintainer's review queue page (`/review.html`, docs/specs/community-v1.md §4.5). Its own
 * Vite entry; the API refuses the queue to everyone but the maintainer anyway.
 */
import '../styles.css';
import { browserStorage } from '../persist';
import { HttpCommunityClient } from '../sync/community';
import { syncConfig } from '../sync/config';
import { applyTheme, installThemes, loadThemeId } from '../themes';
import { mountReview } from './queue';

const root = document.getElementById('review');
if (root !== null) {
  installThemes();
  applyTheme(loadThemeId(browserStorage()));
  const client = new HttpCommunityClient({
    baseUrl: syncConfig(import.meta.env).baseUrl,
    fetch: (url, init) => fetch(url, init),
    online: () => navigator.onLine,
  });
  void mountReview(root, client);
}
