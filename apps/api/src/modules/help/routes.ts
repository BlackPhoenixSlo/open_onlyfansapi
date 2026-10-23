import rateLimit from '@fastify/rate-limit';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { helpAnswer, helpAsk, helpStatus, type HelpAnswer } from '../../contracts.js';
import { env } from '../../env.js';
import { rateLimited } from '../../lib/errors.js';
import { DOCS } from './manual.js';
import { SYSTEM_PROMPT, userBlock } from './prompt.js';

const MODEL = 'deepseek-v4-flash';
const BASE = 'https://api.deepseek.com';
/** Questions a workspace may send to the model per UTC day. */
const DAILY_CAP = 100;

// Every outcome is a 200 with a sentence to show: the assistant must not look broken when someone needs help.
const NOT_SET_UP: HelpAnswer = { answer: `The help assistant isn't set up on this server — see the [README](${DOCS}/README.md).`, error: 'config' };
const KEY_INVALID: HelpAnswer = { answer: "The help assistant's key is not valid — tell the server admin.", error: 'config' };
const CAP: HelpAnswer = { answer: "Today's help budget is used up — try again after midnight UTC.", error: 'cap' };
const PROVIDER: HelpAnswer = { answer: 'The AI provider is having trouble — try again in a minute.', error: 'provider' };
const EMPTY: HelpAnswer = { answer: 'The AI came back empty — try asking again.', error: 'empty_answer' };
/** Appended to an answer that hit `max_tokens`. */
const CUT_SHORT = '\n\n*(That answer was cut short. Ask about one part of it for the rest.)*';

/** Questions sent to the model per workspace on `day` (UTC). In memory: a restart resets it. Exported for tests. */
export const questionsToday = new Map<string, { day: string; count: number }>();

/** Counts one question for `teamId`, or false when today's cap is used up. */
function takeQuestion(teamId: string): boolean {
  const day = new Date().toISOString().slice(0, 10);
  const used = questionsToday.get(teamId);
  const count = used?.day === day ? used.count : 0;
  if (count >= DAILY_CAP) return false;
  questionsToday.set(teamId, { day, count: count + 1 });
  return true;
}

type FinishReason = 'stop' | 'length' | 'content_filter' | 'insufficient_system_resource' | 'tool_calls';
type Usage = { prompt_tokens?: number; prompt_cache_hit_tokens?: number; completion_tokens?: number };
type Choice = { message?: { content?: string | null }; finish_reason?: FinishReason | null };
type Completion = { choices?: Choice[]; usage?: Usage };
/** What one DeepSeek call came to: the answer to send, and the counts to log. */
type Call = { result: HelpAnswer; status: number | null; finishReason?: FinishReason; usage?: Usage };

/** The model's reply as an answer: a filtered or empty reply is `empty_answer`, a truncated one says so. */
function toAnswer(choice: Choice | undefined): HelpAnswer {
  const text = choice?.message?.content?.trim();
  if (choice?.finish_reason === 'insufficient_system_resource') return PROVIDER;
  if (!text || choice?.finish_reason === 'content_filter') return EMPTY;
  return { answer: choice?.finish_reason === 'length' ? text + CUT_SHORT : text, error: null };
}

/** One DeepSeek chat completion. Never throws: a timeout, network error or a body that is not JSON is `provider`. */
async function callDeepSeek(key: string, user: string): Promise<Call> {
  const res = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      temperature: 0.3,
      max_tokens: 600,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: user },
      ],
    }),
    signal: AbortSignal.timeout(30_000),
  }).catch(() => null);
  if (!res) return { result: PROVIDER, status: null };
  if (!res.ok) {
    await res.body?.cancel();
    return { result: res.status === 401 || res.status === 403 ? KEY_INVALID : PROVIDER, status: res.status };
  }
  const body = (await res.json().catch(() => null)) as Completion | null;
  if (!body) return { result: PROVIDER, status: res.status };
  const choice = body.choices?.[0];
  return { result: toAnswer(choice), status: res.status, finishReason: choice?.finish_reason ?? undefined, usage: body.usage };
}

/**
 * The dashboard's help assistant, mounted at /api. Any signed-in user, members included (as `GET /api/me`); the role
 * and features come from the session, never the body. One question per call: the transcript stays in the browser.
 */
export default async function helpRoutes(app: FastifyInstance) {
  const tags = ['dashboard'];
  const r = app.withTypeProvider<ZodTypeProvider>();

  // onRequest, not preHandler: the rate limit below keys on the session.
  r.addHook('onRequest', app.requireSignedIn);
  await r.register(rateLimit, {
    hook: 'preHandler',
    max: 10,
    timeWindow: 60_000,
    keyGenerator: (request) => `help:${request.session.userId}`,
    errorResponseBuilder: rateLimited,
  });

  r.get('/help', { schema: { tags, response: { 200: helpStatus } }, config: { rateLimit: false } }, async () => ({
    enabled: env.HELP_DEEPSEEK_API_KEY !== undefined,
  }));

  r.post('/help/ask', { schema: { tags, body: helpAsk, response: { 200: helpAnswer } } }, async (request) => {
    const { session } = request;
    const question = request.body.question.trim();
    if (!question) return { answer: 'Ask me something about the product.', error: 'empty_question' } satisfies HelpAnswer;
    const key = env.HELP_DEEPSEEK_API_KEY;
    if (!key) return NOT_SET_UP;
    if (!takeQuestion(session.teamId)) return CAP;

    const started = Date.now();
    const { result, status, finishReason, usage } = await callDeepSeek(key, userBlock(question, session, request.body.page));
    // Counts only: never the question, the answer or the key. A refused key is a warning with status 401/403.
    request.log[result.error ? 'warn' : 'info'](
      {
        team: session.teamId,
        latencyMs: Date.now() - started,
        status,
        finishReason,
        usage: {
          prompt_tokens: usage?.prompt_tokens,
          prompt_cache_hit_tokens: usage?.prompt_cache_hit_tokens,
          completion_tokens: usage?.completion_tokens,
        },
        error: result.error,
      },
      'help assistant answer',
    );
    return result;
  });
}
