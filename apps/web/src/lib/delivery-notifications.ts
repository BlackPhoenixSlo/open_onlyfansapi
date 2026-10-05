import type { DeliveryNotice } from '@api/contracts';
import { useNavigate } from '@tanstack/react-router';
import { useEffect } from 'react';
import { toast } from 'sonner';

/**
 * While signed in, listens to `/api/webhooks/stream` and shows each finished webhook delivery attempt as a toast and, for
 * delivered or failed ones when permission is granted and the tab is hidden, a browser notification. Both open the webhook's page.
 */
export function useDeliveryNotifications(userId: string | undefined) {
  const navigate = useNavigate();
  useEffect(() => {
    if (!userId) return;
    const source = new EventSource('/api/webhooks/stream');
    source.addEventListener('delivery', (e) => {
      const n = JSON.parse(e.data) as DeliveryNotice;
      const outcome = n.status === 'delivered' ? `HTTP ${n.statusCode}` : n.error;
      const description = `${n.description || new URL(n.url).host} · ${n.status} · ${outcome}`;
      const open = () => void navigate({ to: '/webhooks/$id', params: { id: n.endpointId } });
      const show = n.status === 'delivered' ? toast.success : n.status === 'retrying' ? toast.warning : toast.error;
      show(n.eventType, { description, action: { label: 'View', onClick: open } });
      // A retry is not final: only delivered and failed reach the desktop.
      if (n.status !== 'retrying' && document.hidden && 'Notification' in window && Notification.permission === 'granted') {
        const notification = new Notification(n.eventType, { body: description, tag: n.deliveryId });
        notification.onclick = () => {
          window.focus();
          open();
          notification.close();
        };
      }
    });
    return () => source.close();
  }, [userId, navigate]);
}
