import { Hono } from 'hono';
import { handle } from 'hono/cloudflare-pages';

export type Bindings = {
  DB: D1Database;
  PDF_KV: KVNamespace;
};

const app = new Hono<{ Bindings: Bindings }>();

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
  
  const books = results.map(b => ({
    ...b,
    hasUploadedPdf: !!b.hasUploadedPdf,
    featured: !!b.featured,
    fullContent: b.fullContent ? JSON.parse(b.fullContent as string) : undefined
  }));
  
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
    b.id, b.title, b.subtitle || null, b.category, b.author, b.year || null, b.pages || 0,
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
  await c.env.DB.prepare('DELETE FROM books WHERE id = ?').bind(id).run();
  await c.env.PDF_KV.delete(`pdf:${id}`);
  return c.json({ success: true });
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
