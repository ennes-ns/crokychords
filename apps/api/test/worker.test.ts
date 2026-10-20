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

  // test/assets/_headers is a symlink to apps/web/public/_headers, the file the web build ships.
  it('serves the static app with the CSP and security headers from _headers', async () => {
    const res = await SELF.fetch('https://chords.example.test/');
    expect(res.status).toBe(200);
    const csp = res.headers.get('Content-Security-Policy') ?? '';
    for (const directive of [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self'",
      "font-src 'self'",
      "img-src 'self' data:",
      "connect-src 'self'",
      "object-src 'none'",
      "base-uri 'self'",
      "frame-ancestors 'none'",
    ]) {
      expect(csp.split(';').map((d) => d.trim())).toContain(directive);
    }
    expect(csp).not.toContain('unsafe');
    expect(res.headers.get('Strict-Transport-Security')).toBe('max-age=31536000');
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(res.headers.get('X-Frame-Options')).toBe('DENY');
    expect(res.headers.get('Referrer-Policy')).toBe('no-referrer');
  });

  it('serves SoundFont samples with a long immutable cache, ignoring the version query', async () => {
    const res = await SELF.fetch('https://chords.example.test/soundfonts/flute/C4.ogg?v=0123abcd');
    expect(res.status).toBe(200);
    expect(new TextDecoder().decode(await res.arrayBuffer())).toBe('soundfont fixture\n');
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=31536000, immutable');
    // The page-wide security headers still apply.
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    const page = await SELF.fetch('https://chords.example.test/');
    expect(page.headers.get('Cache-Control') ?? '').not.toContain('immutable');
  });

  it('never serves the _headers file itself', async () => {
    const res = await SELF.fetch('https://chords.example.test/_headers');
    expect(await res.text()).not.toContain('Content-Security-Policy');
  });

  it('keeps the strict API headers on /api/* (Worker, not _headers)', async () => {
    const res = await SELF.fetch('https://chords.example.test/api/me');
    expect(res.headers.get('Content-Security-Policy')).toBe(
      "default-src 'none'; frame-ancestors 'none'",
    );
    expect(res.headers.get('Strict-Transport-Security')).toBe('max-age=31536000');
  });

  it('answers unknown non-asset paths with the JSON 404', async () => {
    const res = await SELF.fetch('https://chords.example.test/nope');
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: { code: 'not_found' } });
  });
});
