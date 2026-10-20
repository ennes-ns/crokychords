// A small, dependency-free Chrome DevTools Protocol client for driving the web app headlessly
// (docs/howto/agents.md). It always starts Chromium muted (--mute-audio) on a random debugging
// port above 9400 with a throwaway profile, so no run ever plays sound on the host or touches a
// real browser profile. Node 22 has a global WebSocket, so nothing needs installing.
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

/** Flags every launch gets; --mute-audio is not optional. */
export const CHROMIUM_FLAGS = [
  '--headless=new',
  '--mute-audio',
  '--autoplay-policy=no-user-gesture-required',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-gpu',
  '--disable-extensions',
  '--disable-background-networking',
];

const CANDIDATES = [
  'chromium',
  'chromium-browser',
  'google-chrome',
  'google-chrome-stable',
  'chrome',
];

/** The Chromium binary: $CHROME_PATH, else the first of CANDIDATES on the PATH. */
export function findChromium() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  for (const name of CANDIDATES) {
    const found = spawnSync('which', [name], { encoding: 'utf8' });
    if (found.status === 0 && found.stdout.trim() !== '') return found.stdout.trim();
  }
  throw new Error('no Chromium found: install chromium or set CHROME_PATH');
}

/** Remove a throwaway profile; Chromium's helpers may still be writing to it for a moment. */
function removeProfile(dir) {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  } catch (e) {
    console.error(`could not remove ${dir}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Whether `port` is free on 127.0.0.1. */
function isFree(port) {
  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
  });
}

/** A free random port in [min, max). */
export async function randomPort(min, max) {
  for (let i = 0; i < 50; i++) {
    const port = min + Math.floor(Math.random() * (max - min));
    if (await isFree(port)) return port;
  }
  throw new Error(`no free port between ${min} and ${max}`);
}

/** Poll `url` until it answers 2xx (or `ms` passes). */
export async function waitForHttp(url, ms = 30_000) {
  const until = Date.now() + ms;
  let last = '';
  while (Date.now() < until) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (res.ok) return res;
      last = `HTTP ${res.status}`;
    } catch (e) {
      last = e instanceof Error ? e.message : String(e);
    }
    await sleep(200);
  }
  throw new Error(`${url} did not answer within ${ms} ms (${last})`);
}

/**
 * Start a muted headless Chromium. Returns `{ port, newPage(url), close() }`; `close` also
 * removes the throwaway profile.
 */
export async function launchChromium({ chrome = findChromium(), port } = {}) {
  const debugPort = port ?? (await randomPort(9401, 9999));
  const profile = mkdtempSync(join(tmpdir(), 'croky-agent-'));
  const flags = [
    ...CHROMIUM_FLAGS,
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${profile}`,
  ];
  // CI runners restrict the user namespaces Chromium's sandbox needs.
  if (process.env.CI) flags.push('--no-sandbox');
  const child = spawn(chrome, [...flags, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (d) => (stderr = (stderr + d).slice(-4000)));
  const base = `http://127.0.0.1:${debugPort}`;
  let version;
  try {
    version = await (await waitForHttp(`${base}/json/version`, 20_000)).json();
  } catch (e) {
    child.kill('SIGKILL');
    removeProfile(profile);
    throw new Error(`Chromium did not start: ${e.message}\n${stderr}`);
  }
  return {
    port: debugPort,
    async newPage(url = 'about:blank') {
      const res = await fetch(`${base}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' });
      if (!res.ok) throw new Error(`could not open a page (HTTP ${res.status})`);
      const target = await res.json();
      return connect(target.webSocketDebuggerUrl);
    },
    async close() {
      const exited = new Promise((r) => (child.exitCode === null ? child.once('exit', r) : r()));
      // A graceful Browser.close lets every helper process finish writing the profile.
      try {
        const session = await connect(version.webSocketDebuggerUrl);
        await Promise.race([session.send('Browser.close'), sleep(2000)]);
      } catch {
        child.kill('SIGTERM');
      }
      await Promise.race([exited, sleep(5000)]);
      if (child.exitCode === null) child.kill('SIGKILL');
      removeProfile(profile);
    },
  };
}

/** A CDP session on one page: `send(method, params)`, `evaluate(expr)`, `on(event, fn)`. */
export async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', () => reject(new Error(`cannot connect to ${wsUrl}`)), {
      once: true,
    });
  });
  let nextId = 1;
  const pending = new Map();
  const listeners = new Map();
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(String(event.data));
    if (msg.id !== undefined) {
      const call = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) call?.reject(new Error(`${msg.error.message} (${msg.error.code})`));
      else call?.resolve(msg.result);
    } else {
      for (const fn of listeners.get(msg.method) ?? []) fn(msg.params);
    }
  });
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  return {
    send,
    on(method, fn) {
      listeners.set(method, [...(listeners.get(method) ?? []), fn]);
    },
    /** Evaluate `expression` in the page (promises awaited, the value returned as JSON). */
    async evaluate(expression) {
      const out = await send('Runtime.evaluate', {
        expression,
        awaitPromise: true,
        returnByValue: true,
      });
      if (out.exceptionDetails) {
        const text = out.exceptionDetails.exception?.description ?? out.exceptionDetails.text;
        throw new Error(`page threw: ${text}`);
      }
      return out.result.value;
    },
    close() {
      ws.close();
    },
  };
}
