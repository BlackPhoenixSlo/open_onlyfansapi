export { cn } from "cn"

export function formatBytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 ** 2).toFixed(1)} MB`;
}

/** Pretty-prints a JSON string; anything else is returned unchanged. */
export function prettyJson(body: string) {
  try {
    return JSON.stringify(JSON.parse(body), null, 2);
  } catch {
    return body;
  }
}

/** OF amounts are US dollars. */
export const formatMoney = (cents: number) => `$${(cents / 100).toFixed(2)}`;

/** `@username`, else `chat <id>` when the chat list never named the fan. */
export const fanName = (f: { fanUsername: string | null; chatId: number }) => (f.fanUsername ? `@${f.fanUsername}` : `chat ${f.chatId}`);

/** The fan in a file name: `username`, else `chat-<id>`. */
export const fanFileName = (f: { fanUsername: string | null; chatId: number }) => f.fanUsername ?? `chat-${f.chatId}`;
