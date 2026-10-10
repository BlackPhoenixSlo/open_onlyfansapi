import type { Account } from '@api/contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { LoaderCircle } from 'lucide-react';
import { toast } from 'sonner';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { accountsQuery, api } from '@/lib/api';

/** Confirms and runs an account disconnect. Mount it only while open; it stays open until the request settles. */
export function DisconnectDialog({ account, onClose }: { account: Account; onClose: () => void }) {
  const queryClient = useQueryClient();
  const disconnect = useMutation({
    mutationFn: () => api<void>(`/api/accounts/${account.id}`, { method: 'DELETE' }),
    onSuccess: () => {
      toast.success('Account disconnected');
      onClose();
      void queryClient.invalidateQueries({ queryKey: accountsQuery.queryKey });
    },
    onError: (e) => toast.error(e.message),
  });

  return (
    <AlertDialog open onOpenChange={(open) => !open && !disconnect.isPending && onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Disconnect {account.username ? `@${account.username}` : (account.label ?? account.id)}?</AlertDialogTitle>
          <AlertDialogDescription>
            Deletes the account's OnlyFans session here: it stops receiving events and API calls for it fail. Its
            analytics history is kept, and this workspace can connect it again later with a fresh cURL.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={disconnect.isPending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={disconnect.isPending}
            // Radix closes the dialog on click; it closes on success instead.
            onClick={(e) => {
              e.preventDefault();
              disconnect.mutate();
            }}
          >
            {disconnect.isPending && <LoaderCircle className="animate-spin" />}
            Disconnect
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
