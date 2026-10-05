import { useEffect, useState } from 'react';

// The Fastt Login Capture extension: captures an OnlyFans login and copies it as a cURL.
const FASTT_EXTENSION_ID: string = import.meta.env.VITE_FASTT_EXTENSION_ID || 'anjjmiahkfondbhahocpkehjjabkommc';
export const FASTT_STORE_URL = `https://chromewebstore.google.com/detail/fastt-login-capture-of-+/${FASTT_EXTENSION_ID}`;

/**
 * Whether the Fastt Login Capture extension is installed: it exposes icons/icon16.png to every page, so loading it
 * via chrome-extension:// succeeds only when installed (Chromium only; anything else reads as missing).
 * Checked on mount and again on window focus (e.g. after returning from the store).
 */
export function useFasttExtension(): 'checking' | 'installed' | 'missing' {
  const [state, setState] = useState<'checking' | 'installed' | 'missing'>('checking');
  useEffect(() => {
    let run = 0;
    let cancel = () => {};
    const check = () => {
      cancel();
      const id = ++run;
      const img = new Image();
      const done = (installed: boolean) => {
        if (id !== run) return;
        clearTimeout(timer);
        setState(installed ? 'installed' : 'missing');
      };
      const timer = setTimeout(() => done(false), 2000);
      img.onload = () => done(true);
      img.onerror = () => done(false);
      img.src = `chrome-extension://${FASTT_EXTENSION_ID}/icons/icon16.png`;
      cancel = () => {
        clearTimeout(timer);
        img.onload = img.onerror = null;
      };
    };
    check();
    window.addEventListener('focus', check);
    return () => {
      run++;
      cancel();
      window.removeEventListener('focus', check);
    };
  }, []);
  return state;
}
