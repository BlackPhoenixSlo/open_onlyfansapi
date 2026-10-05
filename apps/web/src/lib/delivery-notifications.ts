import type { DeliveryNotice, LiveEvent } from '@api/contracts';
import { useNavigate } from '@tanstack/react-router';
import { useEffect } from 'react';
import { toast } from 'sonner';

/** Receivers of the stream's `event` frames and of its open/closed state (the webhooks page's Live events card). */
type LiveListener = { event: (e: LiveEvent) => void; open: (open: boolean) => void };
const live = new Set<LiveListener>();
let streamOpen = false;

function setStreamOpen(open: boolean) {
  streamOpen = open;
  for (const l of live) l.open(open);
}

export const isStreamOpen = () => streamOpen;

/** Listens on the one stream the app layout opens; returns the unsubscribe function. */
export function subscribeLive(l: LiveListener): () => void {
  live.add(l);
  return () => {
    live.delete(l);
  };
}

/**
 * While signed in, listens to `/api/webhooks/stream` and shows each finished webhook delivery attempt as a toast and, for
 * delivered or failed ones when permission is granted and the tab is hidden, a browser notification. Both open the webhook's page.
 */
export function useDeliveryNotifications(userId: string | undefined) {
  const navigate = useNavigate();
  useEffect(() => {
    if (!userId) return;
    const source = new EventSource('/api/webhooks/stream');
    source.onopen = () => setStreamOpen(true);
    source.onerror = () => setStreamOpen(false); // EventSource retries on its own
    source.addEventListener('event', (e) => {
      const event = JSON.parse(e.data) as LiveEvent;
      for (const l of live) l.event(event);
    });
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
    return () => {
      source.close();
      setStreamOpen(false);
    };
  }, [userId, navigate]);
}
