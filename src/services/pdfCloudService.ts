import { savePdfToIndexedDb, getPdfFromIndexedDb } from '../utils/pdfStorage.ts';

export interface CloudPdfResult {
  dataUrl: string;
  fileName: string;
}

/**
 * Converts a data URL (e.g. "data:application/pdf;base64,...") to a standard binary Blob.
 */
export function dataUrlToBlob(dataUrl: string): Blob {
  const parts = dataUrl.split(',');
  const mime = parts[0].match(/:(.*?);/)?.[1] || 'application/pdf';
  const rawBase64 = parts.length > 1 ? parts[1] : parts[0];
  const base64Data = rawBase64.replace(/\s/g, '');
  const binaryString = atob(base64Data);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return new Blob([bytes], { type: mime });
}

/**
 * Uploads a real PDF file directly to the server storage without third-party quota limits.
 */
export async function uploadPdfToCloud(
  bookId: string,
  pdfDataUrl: string,
  fileName: string,
  onProgress?: (percent: number) => void
): Promise<{ totalChunks: number; totalSize: number }> {
  if (onProgress) onProgress(30);

  // Cache in IndexedDB for instant offline access
  try {
    await savePdfToIndexedDb(bookId, pdfDataUrl, fileName);
  } catch (err) {
    console.warn('Could not cache PDF in local IndexedDB:', err);
  }

  if (onProgress) onProgress(60);

  const res = await fetch(`/api/books/${bookId}/pdf`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pdfDataUrl, fileName }),
  });

  if (!res.ok) {
    throw new Error(`Failed to upload PDF to server storage (HTTP ${res.status})`);
  }

  if (onProgress) onProgress(100);
  return { totalChunks: 1, totalSize: pdfDataUrl.length };
}

/**
 * Fetches the real PDF from server storage or local cache.
 */
export async function fetchPdfFromCloud(
  bookId: string,
  onProgress?: (percent: number) => void
): Promise<CloudPdfResult | null> {
  // 1. Check local IndexedDB first
  try {
    const local = await getPdfFromIndexedDb(bookId);
    if (local && typeof local === 'string' && local.startsWith('data:application/pdf')) {
      if (onProgress) onProgress(100);
      return { dataUrl: local, fileName: `${bookId}.pdf` };
    }
  } catch {
    // Continue to server
  }

  if (onProgress) onProgress(30);

  // 2. Fetch from server storage
  try {
    const res = await fetch(`/api/books/${bookId}/pdf`);
    if (!res.ok) {
      return null;
    }

    if (onProgress) onProgress(70);

    const blob = await res.blob();
    const reader = new FileReader();

    return new Promise((resolve) => {
      reader.onloadend = async () => {
        const dataUrl = reader.result as string;
        const fileName = `${bookId}.pdf`;
        try {
          await savePdfToIndexedDb(bookId, dataUrl, fileName);
        } catch {
          // ignore
        }
        if (onProgress) onProgress(100);
        resolve({ dataUrl, fileName });
      };
      reader.onerror = () => {
        resolve(null);
      };
      reader.readAsDataURL(blob);
    });
  } catch (err) {
    console.warn('Could not fetch PDF from server:', err);
    return null;
  }
}

/**
 * Cleans up PDF file on server when book is deleted.
 */
export async function deletePdfFromCloud(_bookId: string): Promise<void> {
  // The server DELETE /api/books/:id already deletes the associated PDF file on disk.
}
