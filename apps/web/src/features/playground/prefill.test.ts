import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultDraft, initialDraft, overlayRows, pickAccount, pushRecent, rememberDraft, smartDefault } from './prefill';
import { type Param, operations } from './spec';

const NOW = new Date('2026-10-05T12:00:00Z');
const q = (name: string, extra: Partial<Param> = {}): Param => ({
  name,
  in: 'query',
  required: false,
  type: 'string',
  description: undefined,
  placeholder: undefined,
  format: undefined,
  maximum: undefined,
  ...extra,
});

describe('smartDefault', () => {
  it('prefills limit, capped by the spec maximum', () => {
    expect(smartDefault(q('limit'), NOW)).toBe('20');
    expect(smartDefault(q('limit', { maximum: 10 }), NOW)).toBe('10');
  });

  it('prefills date ranges as the last 7 days, in the spec format', () => {
    expect(smartDefault(q('from', { format: 'date' }), NOW)).toBe('2026-09-28');
    expect(smartDefault(q('to'), NOW)).toBe('2026-10-05');
    expect(smartDefault(q('start_date'), NOW)).toBe('2026-09-28');
    expect(smartDefault(q('endDate', { format: 'date-time' }), NOW)).toBe('2026-10-05T12:00:00.000Z');
  });

  it('leaves everything else empty', () => {
    expect(smartDefault(q('offset'), NOW)).toBe('');
    expect(smartDefault(q('page'), NOW)).toBe('');
    expect(smartDefault({ ...q('limit'), in: 'path' }, NOW)).toBe('');
  });
});

const [stats, chats, send] = operations({
  paths: {
    '/v1/stats': {
      get: {
        parameters: [
          { name: 'to', in: 'query', schema: { type: 'string', pattern: String.raw`^\d{4}-\d{2}-\d{2}$` } },
          { name: 'from', in: 'query', required: true, schema: { type: 'string', pattern: String.raw`^\d{4}-\d{2}-\d{2}$` } },
        ],
      },
    },
    '/v1/{account}/chats': {
      get: {
        summary: 'Chats List',
        operationId: 'chats.list',
        parameters: [
          { name: 'account', in: 'path', required: true, schema: { type: 'integer' } },
          { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 50, default: 10 } },
          { name: 'order', in: 'query', schema: { type: 'string', enum: ['recent', 'old'], default: 'recent' } },
        ],
      },
    },
    '/v1/{account}/chats/{chat_id}/messages': {
      post: {
        parameters: [{ name: 'chat_id', in: 'path', required: true, description: 'The chat', schema: { type: 'integer' } }],
        requestBody: { content: { 'application/json': { schema: { $ref: '#/components/schemas/SendMessage' } } } },
      },
    },
  },
  components: {
    schemas: {
      SendMessage: {
        type: 'object',
        required: ['text'],
        properties: { price: { type: 'number', default: 0 }, text: { type: 'string', description: 'Message text' } },
      },
    },
  },
});

describe('operations', () => {
  it('reads parameter metadata, required first, without the account', () => {
    expect(stats!.params.map((p) => [p.name, p.required, p.format])).toEqual([
      ['from', true, 'date'],
      ['to', false, 'date'],
    ]);
    expect(chats!.summary).toBe('Chats List');
    expect(chats!.params.map((p) => [p.name, p.type, p.placeholder])).toEqual([
      ['limit', 'integer 1–50', '10'],
      ['order', 'recent | old', 'recent'],
    ]);
    expect(send!.params[0]).toMatchObject({ name: 'chat_id', in: 'path', required: true, description: 'The chat' });
  });

  it('seeds the body with a skeleton of the required properties and lists the fields', () => {
    expect(JSON.parse(send!.body!)).toEqual({ text: '' });
    expect(send!.fields.map((f) => [f.name, f.required, f.description])).toEqual([
      ['text', true, 'Message text'],
      ['price', false, undefined],
    ]);
    expect(stats!.body).toBeNull();
  });
});

describe('remembered drafts', () => {
  beforeEach(() => {
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => store.set(k, v),
      removeItem: (k: string) => store.delete(k),
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('restores what was changed and keeps the other defaults fresh', () => {
    const draft = defaultDraft(chats!);
    expect(draft.query).toEqual([
      { key: 'limit', value: '20' },
      { key: 'order', value: '' },
    ]);
    rememberDraft(chats!, { ...draft, query: [draft.query[0]!, { key: 'order', value: 'old' }, { key: 'extra', value: '1' }] });
    expect(initialDraft(chats!).query).toEqual([
      { key: 'limit', value: '20' },
      { key: 'order', value: 'old' },
      { key: 'extra', value: '1' },
    ]);
    rememberDraft(chats!, draft);
    expect(initialDraft(chats!)).toEqual(draft);
  });

  it('ignores a stored draft of the wrong shape', () => {
    localStorage.setItem('gateway.playground.op.' + chats!.id, JSON.stringify({ params: {}, query: [{ key: 'limit' }] }));
    expect(initialDraft(chats!)).toEqual(defaultDraft(chats!));
  });

  it('keeps the 8 most recent operations, newest first', () => {
    for (let i = 0; i < 10; i++) pushRecent(`op${i}`);
    expect(pushRecent('op3')).toEqual(['op3', 'op9', 'op8', 'op7', 'op6', 'op5', 'op4', 'op2']);
  });
});

describe('overlayRows', () => {
  it('puts each row on the first free base row of its key and appends the rest', () => {
    const row = (key: string, value: string) => ({ key, value });
    expect(overlayRows([row('a', ''), row('b', '2')], [row('x', '9'), row('b', '3'), row('b', '4'), row('a', '1')])).toEqual([
      row('a', '1'),
      row('b', '3'),
      row('x', '9'),
      row('b', '4'),
    ]);
  });
});

describe('pickAccount', () => {
  it('prefers the only account, then the last used one, then the first', () => {
    expect(pickAccount(['7'], '9')).toBe('7');
    expect(pickAccount(['7', '9'], '9')).toBe('9');
    expect(pickAccount(['7', '9'], '3')).toBe('7');
    expect(pickAccount([], '3')).toBe('');
  });
});
