import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

/** The public mirror of this repository. */
export const GITHUB = 'https://github.com/BlackPhoenixSlo/open_onlyfansapi';
const REPO = `${GITHUB}/blob/master`;

/** A file in the GitHub repository, e.g. `docs/webhooks.md`. */
export function repoUrl(path: string) {
  return `${REPO}/${path}`;
}

/** An inline link to a file in the GitHub repository. */
export function RepoLink({ path, children }: { path: string; children: ReactNode }) {
  return (
    <a href={repoUrl(path)} className="font-medium underline underline-offset-4">
      {children}
    </a>
  );
}

/** A landing section: a heading, a muted introduction, then the content. */
export function Section({
  id,
  title,
  intro,
  children,
}: {
  id: string;
  title: string;
  intro: ReactNode;
  children: ReactNode;
}) {
  return (
    <section id={id} className="border-t py-12 md:py-16">
      <h2 className="mb-2 text-[1.8rem] leading-tight font-semibold">{title}</h2>
      <p className="max-w-[46rem] text-muted-foreground">{intro}</p>
      {children}
    </section>
  );
}

/** A code block; `children` is the literal text. */
export function Pre({ children, className }: { children: string; className?: string }) {
  return (
    <pre className={cn('overflow-x-auto rounded-lg border bg-muted px-4 py-3.5 text-[0.88em] leading-normal', className)}>
      <code>{children}</code>
    </pre>
  );
}
