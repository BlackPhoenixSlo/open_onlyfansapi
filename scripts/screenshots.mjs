// Captures dashboard screenshots and a walkthrough video of a running Gateway into docs/media/.
// Usage: pnpm media   (env: BASE_URL, EMAIL, PASSWORD; the workspace must be linked, see the hint it prints)
// ACCOUNT: the account the seed calls use (default 1, which the fake upstream answers). VIDEO=0 skips the video.
// ONLY=conversations,stats,revenue takes only those shots (names in SHOTS), without seeding or the video.
// Screenshots blur names, handles, avatars, message texts and emails (REDACT), so real data can be shot.
// A fresh account must verify its email: with DATABASE_URL set to the gateway's database the script marks it verified.
// First run on a linked workspace seeds a `demo-read` API key and a few proxied calls (the secret is never printed).
import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
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
const ACCOUNT = process.env.ACCOUNT ?? '1';
const ONLY = process.env.ONLY?.split(',');
/** Proxied calls for the logs and usage pages; the fake upstream echoes any `/of/*` path. */
const SEED_PATHS = [...Array(5).fill(`/v1/${ACCOUNT}/me`), `/v1/${ACCOUNT}/posts?limit=10`, `/v1/${ACCOUNT}/chats?limit=10`];
/** Per shot, what names or identifies a person or account or quotes a message, blurred on top of `all` (the signed-in email). */
const REDACT = {
  all: ['aside [aria-haspopup="menu"]'],
  accounts: ['tbody td:nth-child(-n+5)'], // avatar, display name, @username, label, ID
  playground: ['[aria-label="Account"]', 'pre'], // the account picker, curl (account ID), the response body
  logs: ['tbody td:nth-child(3) > .font-mono', 'tbody td:nth-child(7)'], // path (account ID), account
  conversations: ['.truncate.font-medium', '.truncate.font-medium + div', 'p.break-words'], // fan, chat id, messages
  stats: ['blockquote', 'td:first-child:has(> a[href*="chatId="], > span[title^="A payer"])'], // scripts, fans
  revenue: ['td[title^="Fan "]'], // top payers
  webhooks: ['span[title^="account "]'], // live event account
};

const written = [];
const beat = (page, ms = 1200) => page.waitForTimeout(ms);

async function ok(res, what) {
  if (!res.ok()) throw new Error(`${what}: HTTP ${res.status()} ${await res.text()}`);
  return res.status() === 204 ? null : res.json();
}

/** Marks EMAIL verified in the DATABASE_URL database (pg comes from apps/api); false when unset or no such user. */
async function markVerified() {
  if (!process.env.DATABASE_URL) return false;
  const pg = createRequire(new URL('../apps/api/package.json', import.meta.url))('pg');
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  try {
    const { rowCount } = await db.query('UPDATE "user" SET email_verified = true WHERE lower(email) = lower($1)', [EMAIL]);
    return rowCount > 0;
  } finally {
    await db.end();
  }
}

/**
 * Signs up (an existing account answers 4xx, which is fine) and signs in; the context keeps the cookies.
 * A not-yet-verified account is verified through DATABASE_URL, or the script stops with a hint.
 */
async function signIn(api) {
  const signUp = await api.post(`${BASE_URL}/api/auth/sign-up/email`, {
    headers: { origin: BASE_URL },
    data: { email: EMAIL, password: PASSWORD, name: 'Gateway Demo' },
  });
  if (signUp.status() >= 500) throw new Error(`sign-up: HTTP ${signUp.status()}`);
  const post = () =>
    api.post(`${BASE_URL}/api/auth/sign-in/email`, { headers: { origin: BASE_URL }, data: { email: EMAIL, password: PASSWORD } });
  let res = await post();
  if (res.status() === 403 && (await res.json()).code === 'EMAIL_NOT_VERIFIED') {
    if (!(await markVerified())) {
      throw new Error(
        `${EMAIL} is not verified. Open the verification link (its inbox, or the API log when SMTP is unset), ` +
          'or set DATABASE_URL to the gateway database, then run this script again.',
      );
    }
    res = await post();
  }
  await ok(res, 'sign-in');
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
  conversations: (p) => p.locator('a[href*="chatId="]').or(p.getByText('Workspace not linked')),
  thread: (p) => p.locator('main time').or(p.getByText(/^No messages with this fan/)),
  stats: (p) => p.getByText('Reply time by day').or(p.getByText('Workspace not linked')),
  revenue: (p) => p.getByText('Gross by day').or(p.getByText('Workspace not linked')),
  webhooks: (p) => p.getByText('Live events'),
};

/** Playground: finds the me operation (its group starts collapsed), sends it and waits for the response. */
async function sendUsersMe(page, { typed = false } = {}) {
  await page.getByRole('button', { name: 'Send' }).waitFor();
  const search = page.getByLabel('Search operations');
  if (typed) {
    await search.pressSequentially('me.get', { delay: 90 });
    await beat(page, 900);
  } else await search.fill('me.get');
  await page.locator('button[title="me.get"]').first().click();
  if (typed) await beat(page, 900);
  await page.getByRole('button', { name: 'Send' }).click();
  await page.getByText(/^\d+ ms$/).waitFor();
  await page.waitForLoadState('networkidle');
}

async function shoot(page, name) {
  const hidden = [...REDACT.all, ...(REDACT[name] ?? [])].join(',\n');
  // No transition: a button's `transition-all` would still be fading the blur in when the shot is taken.
  await page.addStyleTag({ content: `${hidden} { filter: blur(6px) !important; transition: none !important; }` });
  const file = join(OUT, `${name}.png`);
  await page.screenshot({ path: file });
  written.push(file);
}

/** Each shot (`<name>.png`): opens its page and waits until it is ready. */
const SHOTS = {
  home: (page) => open(page, '/', ready.home),
  accounts: (page) => open(page, '/accounts', ready.accounts),
  keys: (page) => open(page, '/keys', ready.keys),
  playground: async (page, linked) => {
    await open(page, '/playground', (p) => p.getByLabel('Search operations'));
    if (linked) await sendUsersMe(page);
  },
  logs: (page) => open(page, '/logs', ready.logs),
  usage: async (page) => {
    await open(page, '/usage', ready.usage);
    await beat(page, 1500); // chart animation
  },
  conversations: async (page, linked) => {
    await open(page, '/conversations', ready.conversations);
    if (!linked) return;
    await page.locator('a[href*="chatId="]').first().click();
    await settle(page, ready.thread);
  },
  stats: async (page) => {
    await open(page, '/stats', ready.stats);
    await beat(page, 1500);
  },
  revenue: async (page) => {
    await open(page, '/revenue', ready.revenue);
    await beat(page, 1500);
  },
  webhooks: (page) => open(page, '/webhooks', ready.webhooks),
  'api-reference': async (page) => {
    await open(page, '/docs', ready.docs);
    await beat(page, 800);
  },
};

async function screenshots(page, linked) {
  for (const [name, show] of Object.entries(SHOTS)) {
    if (ONLY && !ONLY.includes(name)) continue;
    await show(page, linked);
    await shoot(page, name);
  }
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
  const unknown = ONLY?.filter((name) => !(name in SHOTS)) ?? [];
  if (unknown.length) throw new Error(`ONLY: no shot named ${unknown.join(', ')}; the shots are ${Object.keys(SHOTS).join(', ')}`);
  await mkdir(OUT, { recursive: true });
  const browser = await chromium.launch();
  const videoDir = await mkdtemp(join(tmpdir(), 'gateway-media-'));
  try {
    const shots = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 2, colorScheme: 'light' });
    await signIn(shots.request);

    const { team } = await ok(await shots.request.get(`${BASE_URL}/v1/whoami`, { headers: DASHBOARD }), 'whoami');
    if (!team.linked) printLinkHint(team.slug);
    else if (!ONLY) await seed(shots.request);

    const page = await shots.newPage();
    await screenshots(page, team.linked);
    const storageState = await shots.storageState();
    await shots.close();

    if (!ONLY && process.env.VIDEO !== '0') {
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
    }
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
