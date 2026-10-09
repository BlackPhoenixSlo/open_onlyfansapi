import { useState } from 'react';
import { toast } from 'sonner';

/** Saves a CSV from the API as `filename`. A plain link would not send `x-dashboard`, so the session would not authorise it. */
export async function downloadCsv(path: string, filename: string) {
  let blob: Blob;
  try {
    const res = await fetch(path, { headers: { 'x-dashboard': '1' }, credentials: 'include' });
    if (!res.ok) {
      toast.error(`CSV export failed (${res.status})`);
      return;
    }
    blob = await res.blob();
  } catch {
    toast.error('CSV export failed (network error)');
    return;
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url));
}

/** `downloadCsv` with a `downloading` flag, to disable the buttons while one runs. */
export function useCsvDownload() {
  const [downloading, setDownloading] = useState(false);
  async function download(path: string, filename: string) {
    setDownloading(true);
    try {
      await downloadCsv(path, filename);
    } finally {
      setDownloading(false);
    }
  }
  return { downloading, download };
}
