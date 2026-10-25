import { describe, expect, it } from 'vitest';
import { canvasToFrame, isOtpCode, otpInput } from './BrowserLoginDialog';

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

describe('the 2FA code field', () => {
  it('drops spaces and dashes, so a pasted "123 456" or "1234-5678" is the code, and changes nothing else', () => {
    expect(otpInput('123 456')).toBe('123456');
    expect(otpInput('1234-5678')).toBe('12345678');
    expect(isOtpCode(otpInput('1234-5678'))).toBe(true);
    // Mistyped or overlong stays wrong (Submit stays off), never cut or filtered into a different valid code.
    expect(otpInput('12a3456')).toBe('12a3456');
    expect(isOtpCode(otpInput('12a3456'))).toBe(false);
    expect(otpInput('123456789')).toBe('123456789');
    expect(isOtpCode(otpInput('123456789'))).toBe(false);
  });

  it('takes 6 to 8 ASCII digits', () => {
    expect(['123456', '1234567', '12345678'].every(isOtpCode)).toBe(true);
    expect(['12345', '123456789', '12a456', '', '１２３４５６'].some(isOtpCode)).toBe(false);
  });
});
