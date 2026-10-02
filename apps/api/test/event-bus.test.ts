import { describe, expect, it, vi } from 'vitest';
import { publish, subscribe, type GatewayEvent } from '../src/lib/event-bus.js';

const event: GatewayEvent = { id: 'evt_1', type: 'message.received', createdAt: new Date(0), accountId: 1, data: {} };

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
