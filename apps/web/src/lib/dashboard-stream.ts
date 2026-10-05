import type { DashboardFrame } from '@api/contracts';
import { useEffect, useSyncExternalStore } from 'react';

// The app layout's one `/api/webhooks/stream` EventSource, fanned out to subscribers (delivery toasts, Live events).
const subscribers = new Set<(frame: DashboardFrame) => void>();
const openWatchers = new Set<() => void>();
let open = false;

function setOpen(next: boolean) {
  open = next;
  for (const fn of openWatchers) fn();
}

/** Receives every frame of the stream; returns the unsubscribe function. */
export function subscribe(fn: (frame: DashboardFrame) => void): () => void {
  subscribers.add(fn);
  return () => {
    subscribers.delete(fn);
  };
}

function watchOpen(fn: () => void): () => void {
  openWatchers.add(fn);
  return () => {
    openWatchers.delete(fn);
  };
}

/** Whether the stream is connected. */
export function useStreamOpen(): boolean {
  return useSyncExternalStore(watchOpen, () => open);
}

const FRAME_EVENTS: DashboardFrame['event'][] = ['event', 'delivery'];

/** While signed in, holds the stream open (EventSource reconnects on its own) and hands each frame to the subscribers. */
export function useDashboardStream(userId: string | undefined) {
  useEffect(() => {
    if (!userId) return;
    const source = new EventSource('/api/webhooks/stream');
    source.onopen = () => setOpen(true);
    source.onerror = () => setOpen(false);
    for (const name of FRAME_EVENTS) {
      source.addEventListener(name, (e) => {
        const frame = { event: name, data: JSON.parse(e.data) } as DashboardFrame;
        for (const fn of subscribers) fn(frame);
      });
    }
    return () => {
      source.close();
      setOpen(false);
    };
  }, [userId]);
}
