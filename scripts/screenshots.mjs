// Captures dashboard screenshots and a walkthrough video of a running Gateway into docs/media/.
// Usage: pnpm media   (env: BASE_URL, EMAIL, PASSWORD; the workspace must be linked, see the hint it prints)
// First run on a linked workspace seeds a `demo-read` API key and a few proxied calls (the secret is never printed).
import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, request } from 'playwright';

const BASE_URL = (process.env.BASE_URL ?? 'http://localhost').replace(/\/+$/, '');
const EMAIL = process.env.EMAIL ?? 'screenshots@example.com';
const PASSWORD = process.env.PASSWORD ?? 'screenshots-pass-2026';
const OUT = fileURLToPath(new URL('../docs/media/', import.meta.url));
const VIEWPORT = { width: 1440, height: 900 };
const DASHBOARD = { origin: BASE_URL, 'x-dashboard': '1' };
/** Proxied calls for the logs and usage pages; the fake upstream echoes any `/of/*` path. */
const SEED_PATHS = [
  ...Array(5).fill('/v1/1/users/me'),
  '/v1/1/users/42/posts?limit=10&order=desc',
  '/v1/1/chats/7/messages?limit=20',
];

const written = [];
const beat = (page, ms = 1200) => page.waitForTimeout(ms);

async function ok(res, what) {
  if (!res.ok()) throw new Error(`${what}: HTTP ${res.status()} ${await res.text()}`);
  return res.status() === 204 ? null : res.json();
}

/** Signs up (an existing account answers 4xx, which is fine) and signs in; the context keeps the cookies. */
async function signIn(api) {
  const signUp = await api.post(`${BASE_URL}/api/auth/sign-up/email`, {
    headers: { origin: BASE_URL },
    data: { email: EMAIL, password: PASSWORD, name: 'Gateway Demo' },
  });
  if (signUp.status() >= 500) throw new Error(`sign-up: HTTP ${signUp.status()}`);
  await ok(
    await api.post(`${BASE_URL}/api/auth/sign-in/email`, { headers: { origin: BASE_URL }, data: { email: EMAIL, password: PASSWORD } }),
    'sign-in',
  );
}

function printLinkHint(slug) {
  console.warn(
    [
      `Workspace "${slug}" is not linked to the upstream: no demo data is seeded and the playground sends nothing.`,
      'Link it, then run this script again:',
      `  server (in deploy/): docker compose exec gateway node dist/db/link-team.js ${slug}`,
      `  local dev:           pnpm --filter @gateway/api link-team ${slug}`,
    ].join('\n'),
  );
}

/** Creates the `demo-read` key and calls with it, unless an active one exists (its secret is gone; revoke it to re-seed). */
async function seed(api) {
  const { items } = await ok(await api.get(`${BASE_URL}/api/keys`, { headers: DASHBOARD }), 'list keys');
  if (items.some((k) => k.name === 'demo-read' && !k.revokedAt)) {
    console.log('demo-read key exists: skipping the seed calls.');
    return;
  }
  const { secret } = await ok(
    await api.post(`${BASE_URL}/api/keys`, { headers: DASHBOARD, data: { name: 'demo-read', scope: 'read' } }),
    'create key',
  );

  const client = await request.newContext({ baseURL: BASE_URL, extraHTTPHeaders: { authorization: `Bearer ${secret}` } });
  try {
    for (const path of SEED_PATHS) {
      const res = await client.get(path);
      if (!res.ok()) throw new Error(`seed call ${path}: HTTP ${res.status()}`);
    }
  } finally {
    await client.dispose();
  }
}

async function open(page, path, ready) {
  await page.goto(`${BASE_URL}${path}`);
  await settle(page, ready);
}

async function settle(page, ready) {
  await ready(page).first().waitFor();
  await page.waitForLoadState('networkidle');
}

const ready = {
  home: (p) => p.getByText(/^\d+\.\d%$/),
  accounts: (p) => p.locator('tbody tr').or(p.getByText('Workspace not linked')),
  keys: (p) => p.locator('tbody tr').or(p.getByText('No keys yet.')),
  logs: (p) => p.locator('tbody tr').or(p.getByText('No requests yet.')),
  usage: (p) => p.getByText('Requests per day (UTC)'),
  logDetail: (p) => p.getByText('Request ID'),
  docs: (p) => p.getByText('Gateway API'),
};

/** Playground: picks the users/me operation, sends it and waits for the response. */
async function sendUsersMe(page, { typed = false } = {}) {
  await page.getByRole('button', { name: 'Send' }).waitFor();
  if (typed) {
    await page.getByLabel('Search operations').pressSequentially('users me', { delay: 90 });
    await beat(page, 900);
  }
  await page.getByRole('button').filter({ hasText: /\/users\/me$/ }).click();
  if (typed) await beat(page, 900);
  await page.getByRole('button', { name: 'Send' }).click();
  await page.getByText(/^\d+ ms$/).waitFor();
  await page.waitForLoadState('networkidle');
}

async function shoot(page, name) {
  const file = join(OUT, name);
  await page.screenshot({ path: file });
  written.push(file);
}

async function screenshots(page, linked) {
  await open(page, '/', ready.home);
  await shoot(page, 'home.png');

  await open(page, '/accounts', ready.accounts);
  await shoot(page, 'accounts.png');

  await open(page, '/keys', ready.keys);
  await shoot(page, 'keys.png');

  await open(page, '/playground', (p) => p.getByLabel('Search operations'));
  if (linked) await sendUsersMe(page);
  await shoot(page, 'playground.png');

  await open(page, '/logs', ready.logs);
  await shoot(page, 'logs.png');

  await open(page, '/usage', ready.usage);
  await beat(page, 1500); // chart animation
  await shoot(page, 'usage.png');

  await open(page, '/docs', ready.docs);
  await beat(page, 800);
  await shoot(page, 'api-reference.png');
}

/** One continuous tour (about 50 s): home, accounts, keys, playground, logs (detail), usage, API reference. */
async function tour(page, linked) {
  const nav = (label) => page.getByRole('link', { name: label, exact: true }).click();

  await open(page, '/', ready.home);
  await beat(page, 4000);

  await nav('Accounts');
  await settle(page, ready.accounts);
  await beat(page, 3500);

  await nav('API keys');
  await settle(page, ready.keys);
  await ready.keys(page).first().hover();
  await beat(page, 3500);

  await nav('Playground');
  await settle(page, (p) => p.getByLabel('Search operations'));
  await beat(page, 1500);
  if (linked) {
    await sendUsersMe(page, { typed: true });
    await beat(page, 1500);
    await page.getByText(/^Headers \(\d+\)$/).click();
  }
  await beat(page, 3500);

  await nav('Logs');
  await settle(page, ready.logs);
  await beat(page, 2000);
  await page.locator('tbody tr a').first().click();
  await settle(page, ready.logDetail);
  await beat(page, 2000);
  await page.mouse.wheel(0, 500);
  await beat(page, 3000);

  await nav('Usage');
  await settle(page, ready.usage);
  await beat(page, 3000);
  for (const groupBy of ['key', 'endpoint']) {
    await page.getByRole('button', { name: groupBy, exact: true }).click();
    await page.waitForLoadState('networkidle');
    await beat(page, 2000);
  }

  await open(page, '/docs', ready.docs);
  await beat(page, 2500);
  for (let i = 0; i < 4; i++) {
    await page.mouse.wheel(0, 450);
    await beat(page, 1800);
  }
}

async function main() {
  await mkdir(OUT, { recursive: true });
  const browser = await chromium.launch();
  const videoDir = await mkdtemp(join(tmpdir(), 'gateway-media-'));
  try {
    const shots = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 2, colorScheme: 'light' });
    await signIn(shots.request);

    const { team } = await ok(await shots.request.get(`${BASE_URL}/v1/whoami`, { headers: DASHBOARD }), 'whoami');
    if (team.linked) await seed(shots.request);
    else printLinkHint(team.slug);

    const page = await shots.newPage();
    await screenshots(page, team.linked);
    const storageState = await shots.storageState();
    await shots.close();

    const video = await browser.newContext({
      viewport: VIEWPORT,
      colorScheme: 'light',
      storageState,
      recordVideo: { dir: videoDir, size: VIEWPORT },
    });
    const tourPage = await video.newPage();
    await tour(tourPage, team.linked);
    await video.close();
    const webm = join(OUT, 'overview.webm');
    await tourPage.video().saveAs(webm);
    written.push(webm);
  } finally {
    await browser.close();
    await rm(videoDir, { recursive: true, force: true });
  }

  for (const file of written) console.log(`${file}  ${((await stat(file)).size / 1024).toFixed(0)} KiB`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
