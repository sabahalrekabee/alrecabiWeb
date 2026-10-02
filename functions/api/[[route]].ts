import { Hono } from 'hono';
import { handle } from 'hono/cloudflare-pages';

export type Bindings = {
  DB: D1Database;
  PDF_KV: KVNamespace;
};

const app = new Hono<{ Bindings: Bindings }>();

// Force all API responses to NEVER be cached by Cloudflare edge or browser
app.use('/api/*', async (c, next) => {
  await next();
  c.header('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0');
  c.header('Pragma', 'no-cache');
  c.header('Expires', '0');
  c.header('Surrogate-Control', 'no-store');
});

// Helper for safe JSON parsing
function safeParseJson(val: any) {
  if (!val) return undefined;
  if (typeof val === 'object') return val;
  try {
    return JSON.parse(val);
  } catch {
    return undefined;
  }
}

// Helper to auto-migrate D1 table for zero-config deployments
async function ensureTableExists(db: D1Database) {
  await db.prepare(`
    CREATE TABLE IF NOT EXISTS books (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      subtitle TEXT,
      category TEXT NOT NULL,
      author TEXT NOT NULL,
      year TEXT,
      pages INTEGER DEFAULT 0,
      description TEXT,
      backCoverBlurb TEXT,
      frontCoverUrl TEXT,
      backCoverUrl TEXT,
      hasUploadedPdf INTEGER DEFAULT 0,
      pdfFileName TEXT,
      pdfFileSize INTEGER DEFAULT 0,
      pdfUrl TEXT,
      featured INTEGER DEFAULT 0,
      createdAt TEXT,
      fullContent TEXT
    );
  `).run();
}

app.get('/api/health', (c) => c.json({ status: 'ok', engine: 'cloudflare-pages-d1-kv', quota: 'unlimited' }));

app.get('/api/books', async (c) => {
  await ensureTableExists(c.env.DB);
  const { results } = await c.env.DB.prepare('SELECT * FROM books ORDER BY createdAt DESC').all();

  // Deduplicate books by normalized title and ID so duplicates never leak to UI
  const seenTitles = new Set<string>();
  const seenIds = new Set<string>();
  const books: any[] = [];
  const duplicateIdsToDelete: string[] = [];

  for (const b of results) {
    const normTitle = ((b.title as string) || '').trim().toLowerCase();
    const id = (b.id as string) || '';

    if (seenIds.has(id) || (normTitle && seenTitles.has(normTitle))) {
      duplicateIdsToDelete.push(id);
      continue;
    }

    if (normTitle) seenTitles.add(normTitle);
    if (id) seenIds.add(id);

    books.push({
      ...b,
      hasUploadedPdf: !!b.hasUploadedPdf,
      featured: !!b.featured,
      fullContent: safeParseJson(b.fullContent)
    });
  }

  // Clean up duplicate rows from D1 asynchronously
  if (duplicateIdsToDelete.length > 0) {
    c.executionCtx?.waitUntil?.(
      Promise.all(duplicateIdsToDelete.map(dupId =>
        c.env.DB.prepare('DELETE FROM books WHERE id = ?').bind(dupId).run().catch(() => {})
      ))
    );
  }

  return c.json(books);
});

app.post('/api/books/init', async (c) => {
  await ensureTableExists(c.env.DB);
  const { results } = await c.env.DB.prepare('SELECT COUNT(*) as count FROM books').all();
  const count = (results[0]?.count as number) || 0;

  const body = await c.req.json();
  if (count === 0 && body && Array.isArray(body.books) && body.books.length > 0) {
    const stmt = c.env.DB.prepare(
      'INSERT INTO books (id, title, subtitle, category, author, year, pages, description, backCoverBlurb, frontCoverUrl, backCoverUrl, hasUploadedPdf, pdfFileName, pdfFileSize, pdfUrl, featured, createdAt, fullContent) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    );
    const batch = body.books.map((b: any) => stmt.bind(
      b.id, b.title, b.subtitle || null, b.category, b.author, b.year || null, b.pages || 0,
      b.description || null, b.backCoverBlurb || null, b.frontCoverUrl || '', b.backCoverUrl || '',
      b.hasUploadedPdf ? 1 : 0, b.pdfFileName || null, b.pdfFileSize || 0, b.pdfUrl || null,
      b.featured ? 1 : 0, b.createdAt || new Date().toISOString(),
      b.fullContent ? JSON.stringify(b.fullContent) : null
    ));
    await c.env.DB.batch(batch);
    return c.json({ message: 'Seeded initial books successfully', count: body.books.length });
  }
  return c.json({ message: 'Database already has books', count });
});

app.post('/api/books', async (c) => {
  await ensureTableExists(c.env.DB);
  const b = await c.req.json();
  if (!b || !b.id) return c.json({ error: 'Invalid book payload' }, 400);

  const cleanTitle = (b.title || '').trim();
  if (!cleanTitle) return c.json({ error: 'Title is required' }, 400);

  // If a book with the same title already exists with a different ID, remove old duplicates
  const { results: existingDups } = await c.env.DB.prepare(
    'SELECT id FROM books WHERE TRIM(LOWER(title)) = TRIM(LOWER(?)) AND id != ?'
  ).bind(cleanTitle, b.id).all();

  if (existingDups && existingDups.length > 0) {
    for (const dup of existingDups) {
      await c.env.DB.prepare('DELETE FROM books WHERE id = ?').bind(dup.id).run().catch(() => {});
      await c.env.PDF_KV.delete(`pdf:${dup.id}`).catch(() => {});
    }
  }

  await c.env.DB.prepare(
    `INSERT INTO books (id, title, subtitle, category, author, year, pages, description, backCoverBlurb, frontCoverUrl, backCoverUrl, hasUploadedPdf, pdfFileName, pdfFileSize, pdfUrl, featured, createdAt, fullContent) 
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET 
      title=excluded.title, subtitle=excluded.subtitle, category=excluded.category, author=excluded.author, 
      year=excluded.year, pages=excluded.pages, description=excluded.description, backCoverBlurb=excluded.backCoverBlurb, 
      frontCoverUrl=excluded.frontCoverUrl, backCoverUrl=excluded.backCoverUrl, hasUploadedPdf=excluded.hasUploadedPdf, 
      pdfFileName=excluded.pdfFileName, pdfFileSize=excluded.pdfFileSize, pdfUrl=excluded.pdfUrl, 
      featured=excluded.featured, createdAt=excluded.createdAt, fullContent=excluded.fullContent`
  ).bind(
    b.id, cleanTitle, b.subtitle || null, b.category, b.author, b.year || null, b.pages || 0,
    b.description || null, b.backCoverBlurb || null, b.frontCoverUrl || '', b.backCoverUrl || '',
    b.hasUploadedPdf ? 1 : 0, b.pdfFileName || null, b.pdfFileSize || 0, b.pdfUrl || null,
    b.featured ? 1 : 0, b.createdAt || new Date().toISOString(),
    b.fullContent ? JSON.stringify(b.fullContent) : null
  ).run();

  return c.json(b);
});

app.delete('/api/books/:id', async (c) => {
  await ensureTableExists(c.env.DB);
  const id = c.req.param('id');
  
  // Also look up title to remove any duplicate copies that might exist with matching title
  const { results } = await c.env.DB.prepare('SELECT title FROM books WHERE id = ?').bind(id).all();
  const bookTitle = results[0]?.title as string | undefined;

  await c.env.DB.prepare('DELETE FROM books WHERE id = ?').bind(id).run();
  await c.env.PDF_KV.delete(`pdf:${id}`).catch(() => {});

  if (bookTitle) {
    // Delete any duplicate copies with the exact same title
    await c.env.DB.prepare('DELETE FROM books WHERE TRIM(LOWER(title)) = TRIM(LOWER(?))').bind(bookTitle).run().catch(() => {});
  }

  return c.json({ success: true, deletedId: id });
});

// Endpoint to purge any duplicate books across the database
app.post('/api/books/deduplicate', async (c) => {
  await ensureTableExists(c.env.DB);
  const { results } = await c.env.DB.prepare('SELECT id, title, createdAt FROM books ORDER BY createdAt DESC').all();

  const seenTitles = new Set<string>();
  const duplicateIds: string[] = [];

  for (const b of results) {
    const normTitle = ((b.title as string) || '').trim().toLowerCase();
    if (seenTitles.has(normTitle)) {
      duplicateIds.push(b.id as string);
    } else {
      seenTitles.add(normTitle);
    }
  }

  for (const dupId of duplicateIds) {
    await c.env.DB.prepare('DELETE FROM books WHERE id = ?').bind(dupId).run().catch(() => {});
    await c.env.PDF_KV.delete(`pdf:${dupId}`).catch(() => {});
  }

  return c.json({ success: true, removedCount: duplicateIds.length });
});

app.post('/api/books/reset', async (c) => {
  await ensureTableExists(c.env.DB);
  await c.env.DB.prepare('DELETE FROM books').run();

  const body = await c.req.json();
  if (Array.isArray(body.books) && body.books.length > 0) {
    const stmt = c.env.DB.prepare(
      'INSERT INTO books (id, title, subtitle, category, author, year, pages, description, backCoverBlurb, frontCoverUrl, backCoverUrl, hasUploadedPdf, pdfFileName, pdfFileSize, pdfUrl, featured, createdAt, fullContent) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    );
    const batch = body.books.map((b: any) => stmt.bind(
      b.id, b.title, b.subtitle || null, b.category, b.author, b.year || null, b.pages || 0,
      b.description || null, b.backCoverBlurb || null, b.frontCoverUrl || '', b.backCoverUrl || '',
      b.hasUploadedPdf ? 1 : 0, b.pdfFileName || null, b.pdfFileSize || 0, b.pdfUrl || null,
      b.featured ? 1 : 0, b.createdAt || new Date().toISOString(),
      b.fullContent ? JSON.stringify(b.fullContent) : null
    ));
    await c.env.DB.batch(batch);
  }
  return c.json({ success: true });
});

// PDF uploads mapped to Cloudflare KV
app.post('/api/books/:id/pdf', async (c) => {
  await ensureTableExists(c.env.DB);
  const id = c.req.param('id');
  const { pdfDataUrl, fileName } = await c.req.json();

  // Note: KV has a 25MB value limit. Base64 adds ~33% overhead. 
  // Max source PDF size should be < ~18MB.
  await c.env.PDF_KV.put(`pdf:${id}`, pdfDataUrl);

  await c.env.DB.prepare('UPDATE books SET hasUploadedPdf = 1, pdfFileName = ?, pdfUrl = ? WHERE id = ?')
    .bind(fileName || `${id}.pdf`, `/api/books/${id}/pdf`, id)
    .run();

  return c.json({ success: true, url: `/api/books/${id}/pdf` });
});

app.get('/api/books/:id/pdf', async (c) => {
  const id = c.req.param('id');
  const pdfDataUrl = await c.env.PDF_KV.get(`pdf:${id}`);
  if (!pdfDataUrl) return c.notFound();

  const base64Data = pdfDataUrl.replace(/^data:application\/pdf;base64,/, '').replace(/\s/g, '');
  const binary = Uint8Array.from(atob(base64Data), char => char.charCodeAt(0));

  let fileName = `${id}.pdf`;
  try {
    const { results } = await c.env.DB.prepare('SELECT pdfFileName FROM books WHERE id = ?').bind(id).all();
    if (results[0]?.pdfFileName) fileName = results[0].pdfFileName as string;
  } catch (e) {
    // fallback if DB query fails
  }

  c.header('Content-Type', 'application/pdf');
  const isDownload = c.req.query('download') === 'true';
  c.header('Content-Disposition', `${isDownload ? 'attachment' : 'inline'}; filename="${fileName}"`);

  return c.body(binary.buffer);
});

app.get('/api/settings', async (c) => {
  const settings = await c.env.PDF_KV.get('app_settings', 'json');
  return c.json(settings || {});
});

app.post('/api/settings', async (c) => {
  const body = await c.req.json();
  const current = (await c.env.PDF_KV.get('app_settings', 'json')) || {};
  const updated = { ...(current as any), ...body };
  await c.env.PDF_KV.put('app_settings', JSON.stringify(updated));
  return c.json(updated);
});

export const onRequest = handle(app);
export default app;
