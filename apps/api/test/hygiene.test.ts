import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ENV_KEYS, parseTrustProxy } from '../src/env.js';

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
