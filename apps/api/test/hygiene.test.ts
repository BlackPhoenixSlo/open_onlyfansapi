import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ENV_KEYS, envSchema, parseTrustProxy } from '../src/env.js';

const root = new URL('../../../', import.meta.url).pathname;
const script = join(root, 'scripts/check-secrets.sh');

describe('hygiene', () => {
  it('.env.example lists every variable env.ts reads, and nothing it does not', () => {
    const listed = readFileSync(join(root, '.env.example'), 'utf8')
      .split('\n')
      .map((line) => /^([A-Z0-9_]+)=/.exec(line)?.[1])
      .filter((k): k is string => k !== undefined);
    expect(listed.filter((k) => k !== 'TEST_DATABASE_URL').sort()).toEqual([...ENV_KEYS].sort());
  });

  it('TRUST_PROXY takes a boolean, a hop count or proxy addresses', () => {
    expect(parseTrustProxy('false')).toBe(false);
    expect(parseTrustProxy('true')).toBe(true);
    const oneHop = parseTrustProxy('1') as (address: string, hop: number) => boolean;
    expect([oneHop('10.0.0.1', 0), oneHop('6.6.6.6', 1)]).toEqual([true, false]);
    expect(parseTrustProxy('10.0.0.0/8, 127.0.0.1')).toEqual(['10.0.0.0/8', '127.0.0.1']);
  });

  it('production refuses a plain-http public URL unless it is localhost', () => {
    const base = {
      DATABASE_URL: 'postgres://gateway@postgres:5432/gateway',
      BETTER_AUTH_SECRET: 'x'.repeat(16),
      UPSTREAM_URL: 'https://upstream.example.com',
      UPSTREAM_TOKEN: 'x'.repeat(16),
    };
    const parse = (url: string, NODE_ENV = 'production') =>
      envSchema.safeParse({ ...base, NODE_ENV, APP_URL: url, BETTER_AUTH_URL: url });

    const rejected = parse('http://gw.example.com');
    expect(rejected.error?.issues.map((i) => i.path[0])).toEqual(['APP_URL', 'BETTER_AUTH_URL']);
    expect(rejected.error?.issues[0]?.message).toContain('without the Secure flag');
    expect([parse('http://localhost'), parse('http://127.0.0.1:4000'), parse('https://gw.example.com')].map((r) => r.success))
      .toEqual([true, true, true]);
    expect(parse('http://gw.example.com', 'development').success).toBe(true);
  });

  it('UPSTREAM_WS_URL: empty means unset, and only ws:// or wss:// is accepted', () => {
    const base = {
      DATABASE_URL: 'postgres://gateway@postgres:5432/gateway',
      APP_URL: 'http://localhost:5173',
      BETTER_AUTH_URL: 'http://localhost:4000',
      BETTER_AUTH_SECRET: 'x'.repeat(16),
      UPSTREAM_URL: 'http://upstream:8000',
      UPSTREAM_TOKEN: 'x'.repeat(16),
    };
    const ws = (UPSTREAM_WS_URL?: string) => envSchema.safeParse({ ...base, UPSTREAM_WS_URL });
    expect([ws(), ws('')].map((r) => r.data?.UPSTREAM_WS_URL)).toEqual([undefined, undefined]);
    expect(ws('ws://upstream:8000/ws').data?.UPSTREAM_WS_URL).toBe('ws://upstream:8000/ws');
    expect(ws('wss://up.example.com/ws').success).toBe(true);
    expect(ws('http://upstream:8000/ws').success).toBe(false);
    expect(ws().data?.EVENT_RETENTION_DAYS).toBe(365);
  });

  it('HELP_DEEPSEEK_API_KEY: empty or blank means unset, and the key is trimmed', () => {
    const base = {
      DATABASE_URL: 'postgres://gateway@postgres:5432/gateway',
      APP_URL: 'http://localhost:5173',
      BETTER_AUTH_URL: 'http://localhost:4000',
      BETTER_AUTH_SECRET: 'x'.repeat(16),
      UPSTREAM_URL: 'http://upstream:8000',
      UPSTREAM_TOKEN: 'x'.repeat(16),
    };
    const key = (HELP_DEEPSEEK_API_KEY?: string) => envSchema.parse({ ...base, HELP_DEEPSEEK_API_KEY }).HELP_DEEPSEEK_API_KEY;
    expect([key(), key(''), key('  \t')]).toEqual([undefined, undefined, undefined]);
    expect(key(' test-only-key\n')).toBe('test-only-key');
  });

  it('SMTP: a host needs a sender address, a user needs a password', () => {
    const base = {
      DATABASE_URL: 'postgres://gateway@postgres:5432/gateway',
      APP_URL: 'http://localhost:5173',
      BETTER_AUTH_URL: 'http://localhost:4000',
      BETTER_AUTH_SECRET: 'x'.repeat(16),
      UPSTREAM_URL: 'http://upstream:8000',
      UPSTREAM_TOKEN: 'x'.repeat(16),
    };
    const smtp = (vars: Record<string, string>) =>
      envSchema.safeParse({ ...base, ...vars }).error?.issues.map((i) => i.path[0]) ?? [];
    expect(smtp({})).toEqual([]);
    expect(smtp({ SMTP_HOST: '', SMTP_USER: '' })).toEqual([]);
    expect(smtp({ SMTP_HOST: 'mail.example.test' })).toEqual(['SMTP_FROM_EMAIL']);
    expect(smtp({ SMTP_HOST: 'mail.example.test', SMTP_USER: 'u@example.test' })).toEqual(['SMTP_PASSWORD']);
    expect(smtp({ SMTP_HOST: 'mail.example.test', SMTP_USER: 'u@example.test', SMTP_PASSWORD: 'p' })).toEqual([]);
    expect(smtp({ SMTP_HOST: 'mail.example.test', SMTP_FROM_EMAIL: 'noreply@example.test' })).toEqual([]);
  });

  it('UPSTREAM_TOKEN: subprotocol-safe characters only', () => {
    const base = {
      DATABASE_URL: 'postgres://gateway@postgres:5432/gateway',
      APP_URL: 'http://localhost:5173',
      BETTER_AUTH_URL: 'http://localhost:4000',
      BETTER_AUTH_SECRET: 'x'.repeat(16),
      UPSTREAM_URL: 'http://upstream:8000',
    };
    const tok = (UPSTREAM_TOKEN: string) => envSchema.safeParse({ ...base, UPSTREAM_TOKEN }).success;
    expect([tok('dev-upstream-token'), tok('a'.repeat(64)), tok('A1b2-C3d4_e5F6.g7~h8')]).toEqual([true, true, true]);
    expect([tok('x'.repeat(16) + '='), tok('abc/def+ghi=jkl=mno'), tok('has space in it!!')]).toEqual([false, false, false]);
  });

  it('check-secrets finds a staged token in a path with spaces', () => {
    const repo = mkdtempSync(join(tmpdir(), 'secrets-'));
    const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { stdio: 'ignore' });
    git('init', '-q');
    writeFileSync(join(repo, 'clean.txt'), 'nothing here\n');
    // Built at runtime so this test file itself stays clean.
    writeFileSync(join(repo, 'my notes.txt'), `key = sk-${'a'.repeat(24)}\n`);
    git('add', '.');
    const staged = spawnSync('sh', [script], { cwd: repo, encoding: 'utf8' });
    expect(staged.status).toBe(1);
    expect(staged.stdout).toContain('my notes.txt');
    expect(spawnSync('sh', [script, '--all'], { cwd: repo }).status).toBe(1);
  });
});
