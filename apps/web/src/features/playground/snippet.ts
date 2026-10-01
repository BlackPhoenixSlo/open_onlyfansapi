/** Single-quotes a value for POSIX shells. */
const sh = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;

/** A curl command for `url` (absolute) that authenticates with `$API_KEY` from the shell. */
export function curlSnippet(req: { method: string; url: string; body?: string | null; contentType?: string }): string {
  // Double quotes so the shell expands $API_KEY.
  const parts = [`curl -X ${req.method} ${sh(req.url)}`, `-H "Authorization: Bearer $API_KEY"`];
  if (req.body) parts.push(`-H ${sh(`Content-Type: ${req.contentType ?? 'application/json'}`)}`, `--data ${sh(req.body)}`);
  return parts.join(' \\\n  ');
}
