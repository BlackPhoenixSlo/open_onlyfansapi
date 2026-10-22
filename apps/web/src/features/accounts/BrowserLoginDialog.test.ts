import { describe, expect, it } from 'vitest';
import { canvasToFrame } from './BrowserLoginDialog';

describe('canvasToFrame', () => {
  const rect = { left: 100, top: 50, width: 640, height: 480 };

  it('offsets by the canvas origin and scales CSS pixels back to native frame pixels', () => {
    // Canvas is CSS-sized 640×480 but the frame is 1280×960, so a click is doubled.
    expect(canvasToFrame(100, 50, rect, 1280, 960)).toEqual({ x: 0, y: 0 });
    expect(canvasToFrame(740, 530, rect, 1280, 960)).toEqual({ x: 1280, y: 960 });
    expect(canvasToFrame(420, 290, rect, 1280, 960)).toEqual({ x: 640, y: 480 });
  });

  it('is identity (bar the offset) when the canvas is shown at its native size', () => {
    expect(canvasToFrame(260, 170, rect, 640, 480)).toEqual({ x: 160, y: 120 });
  });

  it('rounds to whole pixels', () => {
    expect(canvasToFrame(101, 51, rect, 1000, 1000)).toEqual({
      x: Math.round((1 * 1000) / 640),
      y: Math.round((1 * 1000) / 480),
    });
  });
});
