import type { Whoami } from '@api/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { whoamiQuery } from '@/lib/api';
import { authClient } from '@/lib/auth-client';

export const Route = createFileRoute('/_app/settings')({ component: Settings });

function Settings() {
  const whoami = useQuery(whoamiQuery);

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">Settings</h1>
      {whoami.isPending ? (
        <p className="text-muted-foreground">Loading…</p>
      ) : whoami.isError ? (
        <p className="text-destructive">{whoami.error.message}</p>
      ) : (
        <WorkspaceCard team={whoami.data.team} />
      )}
    </div>
  );
}

function WorkspaceCard({ team }: { team: Whoami['team'] }) {
  const queryClient = useQueryClient();
  const [name, setName] = useState(team.name);
  const save = useMutation({
    mutationFn: async () => {
      const { error } = await authClient.organization.update({ organizationId: team.id, data: { name } });
      if (error) throw new Error(error.message ?? 'Could not rename the workspace');
    },
    onSuccess: () => {
      toast.success('Workspace renamed');
      return queryClient.invalidateQueries({ queryKey: whoamiQuery.queryKey });
    },
    onError: (e) => toast.error(e.message),
  });

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    save.mutate();
  }

  return (
    <Card className="max-w-xl">
      <CardHeader>
        <CardTitle>Workspace</CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
        <form onSubmit={onSubmit} className="space-y-2">
          <Label htmlFor="ws-name">Name</Label>
          <div className="flex gap-2">
            <Input id="ws-name" value={name} onChange={(e) => setName(e.target.value)} required />
            <Button type="submit" disabled={save.isPending || name.trim() === '' || name === team.name}>
              Save
            </Button>
          </div>
        </form>
        <div className="space-y-2">
          <Label htmlFor="ws-slug">Slug</Label>
          <Input id="ws-slug" value={team.slug} readOnly className="font-mono" />
        </div>
        <div className="space-y-2">
          <Label>Backend link</Label>
          {team.backendUserId === null ? (
            <p className="text-sm text-muted-foreground">
              Not linked — run{' '}
              <code className="rounded bg-muted px-1 py-0.5">
                pnpm --filter @gateway/api link-team {team.slug} &lt;backendUserId&gt;
              </code>
            </p>
          ) : (
            <p className="text-sm">Linked to backend user #{team.backendUserId}</p>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
