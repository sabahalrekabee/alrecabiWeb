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

  if (prepared.frontCoverUrl && prepared.frontCoverUrl.startsWith('data:image')) {
    try {
      prepared.frontCoverUrl = await compressImage(prepared.frontCoverUrl, 850, 0.82);
    } catch (err) {
      console.warn('Could not compress front cover:', err);
    }
  }

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
 * Subscribes to real-time updates from the server database.
 *
 * FIX: The poll no longer calls onUpdate() if a mutation is in progress.
 * This prevents the "ghost book" bug where a deleted/added book would
 * reappear because a polling interval fired before the server write finished.
 */
export function subscribeToBooks(
  onUpdate: (books: Book[]) => void,
  onError?: (error: Error) => void
): { unsubscribe: () => void; pausePoll: () => void; resumePoll: () => void } {
  let isSubscribed = true;
  // When a mutation (add/delete/reset) is in flight, pause the poll so it
  // doesn't overwrite the optimistic UI update with stale server data.
  let isPaused = false;

  const loadAndEmit = async () => {
    if (isPaused) return;
    try {
      const res = await fetch(`${API_BASE}/books`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const serverBooks: Book[] = await res.json();

      if (!isSubscribed || isPaused) return;

      if (serverBooks.length === 0) {
        await fetch(`${API_BASE}/books/init`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ books: INITIAL_BOOKS }),
        });
        onUpdate(INITIAL_BOOKS);
        saveBooks(INITIAL_BOOKS);
      } else {
        serverBooks.sort((a, b) =>
          new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime()
        );
        onUpdate(serverBooks);
        saveBooks(serverBooks.map(b => ({
          ...b,
          pdfUrl: b.pdfUrl?.startsWith('data:') ? '' : b.pdfUrl
        })));
      }
    } catch (err: any) {
      if (!isSubscribed) return;
      console.warn('Server sync warning (using offline cached state):', err.message);
      if (onError) onError(err);
      const local = getStoredBooks();
      onUpdate(local.length > 0 ? local : INITIAL_BOOKS);
    }
  };

  // Initial load
  loadAndEmit();

  // Poll every 8 seconds (reduces race-condition window and unnecessary network traffic)
  const intervalId = setInterval(loadAndEmit, 8000);

  const handleLocalChange = () => { loadAndEmit(); };
  window.addEventListener('books_database_changed', handleLocalChange);

  return {
    unsubscribe: () => {
      isSubscribed = false;
      clearInterval(intervalId);
      window.removeEventListener('books_database_changed', handleLocalChange);
    },
    pausePoll: () => { isPaused = true; },
    resumePoll: () => {
      isPaused = false;
      loadAndEmit(); // immediately re-sync from server after mutation settles
    },
  };
}

/**
 * Adds or updates a book on the server database.
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

    const res = await fetch(`${API_BASE}/books`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(preparedBook),
    });

    if (!res.ok) throw new Error(`Failed to save book to server (Status ${res.status})`);

    if (hasBase64Pdf && rawPdf) {
      if (onProgress) onProgress(75);
      await fetch(`${API_BASE}/books/${preparedBook.id}/pdf`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pdfDataUrl: rawPdf, fileName: preparedBook.pdfFileName }),
      });
    }

    if (onProgress) onProgress(100);
    window.dispatchEvent(new Event('books_database_changed'));
    return preparedBook;
  } catch (err) {
    console.error('Error adding book to server:', err);
    throw err;
  }
}

export const addBookToFirestore = addBookToServer;

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
    if (!res.ok) throw new Error(`Failed to attach PDF to server (Status ${res.status})`);
    if (onProgress) onProgress(100);
    window.dispatchEvent(new Event('books_database_changed'));
  } catch (err) {
    console.error('Error attaching PDF to book:', err);
    throw err;
  }
}

/**
 * Deletes a book from the server database.
 */
export async function deleteBookFromServer(bookId: string): Promise<void> {
  try {
    const res = await fetch(`${API_BASE}/books/${bookId}`, { method: 'DELETE' });
    if (!res.ok) throw new Error(`Failed to delete book (Status ${res.status})`);
    window.dispatchEvent(new Event('books_database_changed'));
  } catch (err) {
    console.error('Error deleting book from server:', err);
    throw err;
  }
}

export const deleteBookFromFirestore = deleteBookFromServer;

/**
 * Resets library books on the server to the initial catalog.
 */
export async function resetBooksOnServer(): Promise<void> {
  try {
    const res = await fetch(`${API_BASE}/books/reset`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ books: INITIAL_BOOKS }),
    });
    if (!res.ok) throw new Error(`Failed to reset books on server (Status ${res.status})`);
    window.dispatchEvent(new Event('books_database_changed'));
  } catch (err) {
    console.error('Error resetting books on server:', err);
    throw err;
  }
}

export const resetBooksInFirestore = resetBooksOnServer;
