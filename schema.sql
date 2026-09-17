DROP TABLE IF EXISTS books;

CREATE TABLE books (
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
