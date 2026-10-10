import { describe, expect, it, vi } from 'vitest';
import { publish, subscribe, type BusEvent } from '../src/lib/event-bus.js';

const event: BusEvent = { id: 'evt_1', type: 'messages.received', accountId: 1, ts: '2026-10-05T12:00:00.000Z', data: {}, teamId: 'team_1' };

describe('event bus', () => {
  it('delivers synchronously, survives a throwing listener, and stops after unsubscribe', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const seen: string[] = [];
    const offThrow = subscribe(() => {
      throw new Error('boom');
    });
    const off = subscribe((e) => seen.push(e.id));

    publish(event);
    expect(seen).toEqual(['evt_1']);
    expect(error).toHaveBeenCalledOnce();

    off();
    offThrow();
    publish({ ...event, id: 'evt_2' });
    expect(seen).toEqual(['evt_1']);
    error.mockRestore();
  });
});
