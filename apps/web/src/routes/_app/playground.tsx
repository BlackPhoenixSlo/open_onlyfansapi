import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/_app/playground')({
  validateSearch: (s: Record<string, unknown>): { log?: string } => ({
    log: typeof s.log === 'string' ? s.log : undefined,
  }),
  component: () => (
    <div className="space-y-2">
      <h1 className="text-2xl font-semibold">Playground</h1>
      <p className="text-muted-foreground">Coming in the next slice.</p>
    </div>
  ),
});
