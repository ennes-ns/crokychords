import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

// Requests through the whole Worker (asset router + Hono), as wrangler.toml configures it.
describe('one Worker for the web app and the API', () => {
  it('serves the web app from the static assets', async () => {
    const res = await SELF.fetch('https://chords.example.test/');
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('text/html');
    expect(await res.text()).toContain('assets fixture');
  });

  it('runs the API for /api/* and refuses requests without an Access token', async () => {
    const res = await SELF.fetch('https://chords.example.test/api/me');
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: { code: 'unauthorized' } });
  });

  it('never serves a static file under /api/ (run_worker_first)', async () => {
    const res = await SELF.fetch('https://chords.example.test/api/shadowed.txt');
    expect(res.status).toBe(401);
    expect(await res.text()).not.toContain('must never be served');
  });

  it('answers unknown non-asset paths with the JSON 404', async () => {
    const res = await SELF.fetch('https://chords.example.test/nope');
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: { code: 'not_found' } });
  });
});
