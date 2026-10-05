import type { AttemptStatus, DeliveryNotice } from '@api/contracts';
import { useNavigate } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { subscribe } from '@/lib/dashboard-stream';

/** Each attempt outcome's wording and toast. A retry is not final: only delivered and failed reach the desktop. */
const OUTCOME: Record<AttemptStatus, { word: string; show: typeof toast.success; final: boolean }> = {
  succeeded: { word: 'delivered', show: toast.success, final: true },
  pending: { word: 'retrying', show: toast.warning, final: false },
  failed: { word: 'failed', show: toast.error, final: true },
};

/**
 * Shows each finished webhook delivery attempt on the dashboard stream as a toast and, for final ones when permission
 * is granted and the tab is hidden, a browser notification. Both open the webhook's page.
 */
export function useDeliveryToasts() {
  const navigate = useNavigate();
  useEffect(
    () =>
      subscribe((frame) => {
        if (frame.event !== 'delivery') return;
        const n = frame.data;
        const outcome = OUTCOME[n.status];
        const detail = n.status === 'succeeded' ? `HTTP ${n.statusCode}` : n.error;
        const description = `${n.description || new URL(n.url).host} · ${outcome.word} · ${detail}`;
        const open = () => void navigate({ to: '/webhooks/$id', params: { id: n.endpointId } });
        outcome.show(n.eventType, { description, action: { label: 'View', onClick: open } });
        if (outcome.final && document.hidden && 'Notification' in window && Notification.permission === 'granted') {
          const notification = new Notification(n.eventType, { body: description, tag: n.deliveryId });
          notification.onclick = () => {
            window.focus();
            open();
            notification.close();
          };
        }
      }),
    [navigate],
  );
}

/** Asks for the browser-notification permission the delivery toasts use when the tab is hidden; shown until answered. */
export function EnableNotificationsButton() {
  const [permission, setPermission] = useState(() => ('Notification' in window ? Notification.permission : 'denied'));
  if (permission !== 'default') return null;
  return (
    <Button variant="outline" onClick={() => void Notification.requestPermission().then(setPermission)}>
      Enable browser notifications
    </Button>
  );
}
