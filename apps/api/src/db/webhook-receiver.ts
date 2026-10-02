// A local webhook receiver for trying deliveries: listens on :4100, verifies the signature, logs each event.
// Usage: WEBHOOK_SECRET=whsec_... tsx apps/api/src/db/webhook-receiver.ts      (FAIL=1 answers 500 to every POST)
// Point an endpoint at http://localhost:4100/hook with ALLOW_HTTP_WEBHOOKS=true on the API.
import { createServer } from 'node:http';
import { verifySignature } from '../lib/signature.js';

const PORT = 4100;
const secret = process.env.WEBHOOK_SECRET;
const fail = process.env.FAIL === '1';

createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (chunk: Buffer) => chunks.push(chunk));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    const header = (name: string) => String(req.headers[name] ?? '');
    const key = header('x-ofapi-idempotency-key');
    const verdict = !secret
      ? 'signature not checked (WEBHOOK_SECRET unset)'
      : verifySignature(secret, header('signature'), body)
        ? 'signature ok'
        : 'signature INVALID';
    let type = '?';
    try {
      type = (JSON.parse(body.toString()) as { event?: string }).event ?? '?';
    } catch {
      // not JSON
    }
    console.log(`${new Date().toISOString()} ${req.method} ${req.url} ${key} ${type}: ${verdict}${fail ? ' (FAIL=1: 500)' : ''}`);
    res.writeHead(fail ? 500 : 200).end();
  });
}).listen(PORT, () => console.log(`webhook receiver on http://localhost:${PORT}${fail ? ' (FAIL=1)' : ''}`));
