import { useQuery } from '@tanstack/react-query';
import { ArrowUp, ChevronDown, MessageCircle, SendHorizontal, X } from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { askHelp, helpStatusQuery } from '@/lib/api';
import { authClient } from '@/lib/auth-client';
import { PRODUCT_NAME } from '@/lib/brand';
import { readStored, writeStored } from '@/lib/storage';
import { cn } from '@/lib/utils';
import { AnswerText } from './AnswerText';

const MAX_QUESTION = 1000;
/** helpAsk's `page` max (contracts.ts): a longer path is left out, not cut, so the ask is never refused. */
const MAX_PAGE = 200;
const OPEN_KEY = 'gateway.help.open';
/** Below Tailwind's `sm` breakpoint (640px) the panel is a full-screen sheet. */
const PHONE = '(max-width: 639px)';

/** One question and, once it settles, its reply. `muted`: not the model's answer (a cap, an outage, no network). */
type Turn = { id: number; question: string; reply?: { text: string; muted: boolean } };

const isBoolean = (v: unknown): v is boolean => typeof v === 'boolean';

/**
 * The help launcher (bottom-right) and its chat panel: a 400px dock from `sm` up, a full-screen sheet on a phone (the
 * launcher hides while the sheet is open). Hidden when the server has no help assistant. Mounted by the signed-in
 * layout, so the turns outlive the panel (which unmounts when closed); they live in memory only, while the open state
 * survives a reload.
 */
export function HelpWidget() {
  const status = useQuery(helpStatusQuery);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [open, setOpenState] = useState(() => readStored(OPEN_KEY, isBoolean) ?? false);
  // Answers the asker has seen: one that lands while the panel is closed shows the unread dot.
  const [seen, setSeen] = useState(0);
  const nextId = useRef(0);
  const answered = turns.filter((turn) => turn.reply).length;

  function setOpen(next: boolean) {
    setOpenState(next);
    setSeen(answered);
    writeStored(OPEN_KEY, next);
  }

  // The composer stays usable while an answer is pending: each reply settles onto its own turn by id.
  function ask(question: string) {
    const id = ++nextId.current;
    setTurns((all) => [...all, { id, question }]);
    const page = window.location.pathname;
    void askHelp({ question, page: page.length <= MAX_PAGE ? page : undefined })
      .then(
        (res) => ({ text: res.answer, muted: res.error !== null }),
        () => ({ text: "Couldn't reach the assistant — try again in a moment.", muted: true }),
      )
      .then((reply) => setTurns((all) => all.map((turn) => (turn.id === id ? { ...turn, reply } : turn))));
  }

  if (!status.data?.enabled) return null;
  return (
    <>
      {open && <HelpPanel turns={turns} ask={ask} onClose={() => setOpen(false)} />}
      <button
        type="button"
        aria-label="Help assistant"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className={cn(
          'fixed right-5 bottom-5 z-50 flex size-12 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-lg outline-none transition-colors hover:bg-primary/90 focus-visible:ring-3 focus-visible:ring-ring/50',
          open && 'max-sm:hidden',
        )}
      >
        {open ? <ChevronDown className="size-6" /> : <MessageCircle className="size-6" />}
        {!open && answered > seen && <span className="absolute top-0 right-0 size-3 rounded-full bg-destructive ring-2 ring-background" />}
      </button>
    </>
  );
}

function HelpPanel({ turns, ask, onClose }: { turns: Turn[]; ask: (question: string) => void; onClose: () => void }) {
  const { data: session } = authClient.useSession();
  // A team member's name is their username.
  const name = session?.user.displayUsername || session?.user.name;
  const [draft, setDraft] = useState('');
  const composer = useRef<HTMLTextAreaElement>(null);
  const list = useRef<HTMLDivElement>(null);

  // The newest turn in view; scrollTop on the list, so the page itself never scrolls.
  useEffect(() => {
    if (list.current) list.current.scrollTop = list.current.scrollHeight;
  }, [turns]);

  function send(e?: FormEvent) {
    e?.preventDefault();
    const question = draft.trim();
    if (!question) return;
    ask(question);
    setDraft('');
  }

  // On a phone the sheet covers the page a link opens.
  const closeOnPhone = () => {
    if (window.matchMedia(PHONE).matches) onClose();
  };

  return (
    <div
      role="dialog"
      aria-label="Help assistant"
      className="fixed inset-0 z-50 flex flex-col overflow-hidden bg-card text-card-foreground sm:inset-auto sm:right-5 sm:bottom-[84px] sm:h-[min(704px,calc(100dvh-104px))] sm:w-[400px] sm:rounded-2xl sm:border sm:shadow-2xl"
    >
      <header className="flex items-center gap-2 border-b px-4 py-3">
        <span className="flex size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
          <MessageCircle className="size-4" />
        </span>
        <span className="flex-1 truncate font-semibold">{PRODUCT_NAME}</span>
        <Button variant="ghost" size="icon" aria-label="Close" onClick={onClose}>
          <X />
        </Button>
      </header>

      <div ref={list} className="min-h-0 flex-1 overflow-y-auto p-4 text-sm">
        {turns.length === 0 ? (
          <div className="space-y-6 pt-4">
            <p className="text-2xl leading-tight font-semibold">
              Hi {name || 'there'} 👋
              <br />
              <span className="text-muted-foreground">How can we help?</span>
            </p>
            <button
              type="button"
              onClick={() => composer.current?.focus()}
              className="flex w-full items-center justify-between gap-3 rounded-xl border bg-background p-4 text-left shadow-xs transition-colors hover:bg-accent"
            >
              <span>
                <span className="block font-medium">Ask a question</span>
                <span className="text-muted-foreground">Where to click, what to set, which doc to read.</span>
              </span>
              <SendHorizontal className="size-4 shrink-0 text-primary" />
            </button>
          </div>
        ) : (
          <ul className="space-y-3">
            {turns.map((turn) => (
              <li key={turn.id} className="space-y-3">
                <div className="ml-auto w-fit max-w-[85%] rounded-2xl rounded-br-sm bg-primary px-3 py-2 break-words whitespace-pre-wrap text-primary-foreground">
                  {turn.question}
                </div>
                {turn.reply === undefined ? (
                  <div className="w-fit animate-pulse rounded-2xl rounded-bl-sm bg-muted px-3 py-2 text-muted-foreground">
                    thinking…
                  </div>
                ) : (
                  <div
                    className={cn(
                      'w-fit max-w-[85%] rounded-2xl rounded-bl-sm bg-muted px-3 py-2 break-words',
                      turn.reply.muted && 'text-muted-foreground',
                    )}
                  >
                    <AnswerText text={turn.reply.text} onNavigate={closeOnPhone} />
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      <form onSubmit={send} className="flex items-end gap-2 border-t p-3">
        <textarea
          ref={composer}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) send(e);
          }}
          maxLength={MAX_QUESTION}
          rows={1}
          placeholder="Ask a question…"
          aria-label="Your question"
          className="field-sizing-content max-h-40 min-h-10 flex-1 resize-none rounded-2xl border border-input bg-transparent px-3 py-2 text-base outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 sm:text-sm dark:bg-input/30"
        />
        <button
          type="submit"
          aria-label="Send"
          disabled={!draft.trim()}
          className="flex size-10 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground outline-none transition-colors hover:bg-primary/90 focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50"
        >
          <ArrowUp className="size-5" />
        </button>
      </form>
    </div>
  );
}
