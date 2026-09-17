import { Book } from '../types.ts';
import { INITIAL_BOOKS } from '../data/initialBooks.ts';
import { getStoredBooks, saveBooks } from '../utils/storage.ts';
import { compressImage } from '../utils/imageCompressor.ts';

const API_BASE = '/api';

/**
 * Prepares a book before uploading:
 * Compresses front and back covers to ensure fast loading and responsive previews.
 */
export async function prepareBookForStorage(book: Book): Promise<Book> {
  const prepared: Book = { ...book };

  // 1. Compress front cover if base64
  if (prepared.frontCoverUrl && prepared.frontCoverUrl.startsWith('data:image')) {
    try {
      prepared.frontCoverUrl = await compressImage(prepared.frontCoverUrl, 850, 0.82);
    } catch (err) {
      console.warn('Could not compress front cover:', err);
    }
  }

  // 2. Compress back cover if base64
  if (prepared.backCoverUrl && prepared.backCoverUrl.startsWith('data:image')) {
    try {
      prepared.backCoverUrl = await compressImage(prepared.backCoverUrl, 850, 0.82);
    } catch (err) {
      console.warn('Could not compress back cover:', err);
    }
  }

  return prepared;
}

/**
 * Ensures initial default catalog is seeded to the server database
 */
export async function seedInitialBooksIfEmpty(): Promise<void> {
  try {
    const res = await fetch(`${API_BASE}/books`);
    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data) && data.length === 0) {
        await fetch(`${API_BASE}/books/init`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ books: INITIAL_BOOKS }),
        });
      }
    }
  } catch (err) {
    console.warn('Could not check or seed server books database:', err);
  }
}

/**
 * Fetches the current books list from the server
 */
export async function fetchBooks(): Promise<Book[]> {
  try {
    const res = await fetch(`${API_BASE}/books`);
    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data) && data.length > 0) {
        return data;
      }
    }
  } catch (err) {
    console.warn('Error fetching books from server:', err);
  }
  return getStoredBooks();
}

/**
 * Subscribes to updates from the unmetered server database.
 * Uses rapid polling and local custom events for instant multi-tab responsiveness.
 */
export function subscribeToBooks(
  onUpdate: (books: Book[]) => void,
  onError?: (error: Error) => void
): () => void {
  let isSubscribed = true;

  const loadAndEmit = async () => {
    try {
      const res = await fetch(`${API_BASE}/books`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const serverBooks: Book[] = await res.json();

      if (isSubscribed) {
        if (serverBooks.length === 0) {
          // Initialize if empty
          await fetch(`${API_BASE}/books/init`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ books: INITIAL_BOOKS }),
          });
          onUpdate(INITIAL_BOOKS);
          saveBooks(INITIAL_BOOKS);
        } else {
          // Sort newest first
          serverBooks.sort((a, b) => {
            return new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime();
          });
          onUpdate(serverBooks);
          // Keep a safe copy in localStorage without bloated base64 PDFs
          saveBooks(serverBooks.map(b => ({
            ...b,
            pdfUrl: b.pdfUrl?.startsWith('data:') ? '' : b.pdfUrl
          })));
        }
      }
    } catch (err: any) {
      if (isSubscribed) {
        console.warn('Server sync warning (using offline cached state):', err.message);
        if (onError) onError(err);
        const local = getStoredBooks();
        onUpdate(local.length > 0 ? local : INITIAL_BOOKS);
      }
    }
  };

  // Initial load
  loadAndEmit();

  // Periodic polling every 5 seconds (zero cost/quota on self-hosted backend)
  const intervalId = setInterval(loadAndEmit, 5000);

  // Local window event for instant updates across user interactions
  const handleLocalChange = () => {
    loadAndEmit();
  };
  window.addEventListener('books_database_changed', handleLocalChange);

  return () => {
    isSubscribed = false;
    clearInterval(intervalId);
    window.removeEventListener('books_database_changed', handleLocalChange);
  };
}

/**
 * Adds or updates a book on the server database without third-party quota limits.
 */
export async function addBookToServer(
  rawBook: Book,
  onProgress?: (percent: number) => void
): Promise<Book> {
  try {
    if (onProgress) onProgress(20);

    const preparedBook = await prepareBookForStorage(rawBook);
    const hasBase64Pdf = Boolean(rawBook.pdfUrl && rawBook.pdfUrl.startsWith('data:application/pdf'));
    const rawPdf = rawBook.pdfUrl;

    if (hasBase64Pdf) {
      preparedBook.pdfUrl = `/api/books/${preparedBook.id}/pdf`;
      preparedBook.hasUploadedPdf = true;
      preparedBook.pdfFileName = rawBook.pdfFileName || `${preparedBook.title}.pdf`;
    }

    if (onProgress) onProgress(50);

    // 1. Save book metadata to server database
    const res = await fetch(`${API_BASE}/books`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(preparedBook),
    });

    if (!res.ok) {
      throw new Error(`Failed to save book to server (Status ${res.status})`);
    }

    // 2. If PDF was attached, upload it directly to server disk
    if (hasBase64Pdf && rawPdf) {
      if (onProgress) onProgress(75);
      await fetch(`${API_BASE}/books/${preparedBook.id}/pdf`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pdfDataUrl: rawPdf,
          fileName: preparedBook.pdfFileName,
        }),
      });
    }

    if (onProgress) onProgress(100);

    // Notify other components
    window.dispatchEvent(new Event('books_database_changed'));
    return preparedBook;
  } catch (err) {
    console.error('Error adding book to server:', err);
    throw err;
  }
}

// Backward-compatible alias
export const addBookToFirestore = addBookToServer;

/**
 * Attaches or updates a PDF file for a book on the server
 */
export async function attachPdfToBook(
  bookId: string,
  pdfDataUrl: string,
  fileName: string,
  onProgress?: (percent: number) => void
): Promise<void> {
  try {
    if (onProgress) onProgress(30);

    const res = await fetch(`${API_BASE}/books/${bookId}/pdf`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pdfDataUrl, fileName }),
    });

    if (!res.ok) {
      throw new Error(`Failed to attach PDF to server (Status ${res.status})`);
    }

    if (onProgress) onProgress(100);
    window.dispatchEvent(new Event('books_database_changed'));
  } catch (err) {
    console.error('Error attaching PDF to book:', err);
    throw err;
  }
}

/**
 * Deletes a book from the server database
 */
export async function deleteBookFromServer(bookId: string): Promise<void> {
  try {
    const res = await fetch(`${API_BASE}/books/${bookId}`, {
      method: 'DELETE',
    });
    if (!res.ok) {
      throw new Error(`Failed to delete book (Status ${res.status})`);
    }
    window.dispatchEvent(new Event('books_database_changed'));
  } catch (err) {
    console.error('Error deleting book from server:', err);
    throw err;
  }
}

// Backward-compatible alias
export const deleteBookFromFirestore = deleteBookFromServer;

/**
 * Resets library books on the server to the initial catalog
 */
export async function resetBooksOnServer(): Promise<void> {
  try {
    const res = await fetch(`${API_BASE}/books/reset`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ books: INITIAL_BOOKS }),
    });
    if (!res.ok) {
      throw new Error(`Failed to reset books on server (Status ${res.status})`);
    }
    window.dispatchEvent(new Event('books_database_changed'));
  } catch (err) {
    console.error('Error resetting books on server:', err);
    throw err;
  }
}

// Backward-compatible alias
export const resetBooksInFirestore = resetBooksOnServer;
