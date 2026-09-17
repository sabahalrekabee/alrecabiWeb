import React, { useEffect, useRef, useState, useCallback } from 'react';
import * as pdfjsLib from 'pdfjs-dist';
import { 
  ChevronRight, ChevronLeft, ZoomIn, ZoomOut, RotateCw, 
  Maximize2, Minimize2, Download, ExternalLink, Loader2, 
  AlertCircle, Columns
} from 'lucide-react';

// Configure pdfjs worker to unpkg CDN for guaranteed browser compatibility
if (typeof window !== 'undefined') {
  pdfjsLib.GlobalWorkerOptions.workerSrc = `https://unpkg.com/pdfjs-dist@${pdfjsLib.version}/build/pdf.worker.min.mjs`;
}

interface PdfCanvasViewerProps {
  pdfSource: Blob | Uint8Array | ArrayBuffer | string | null;
  bookTitle?: string;
  onDownload?: () => void;
  isDownloading?: boolean;
}

export const PdfCanvasViewer: React.FC<PdfCanvasViewerProps> = ({
  pdfSource,
  bookTitle = 'الكتاب',
  onDownload,
  isDownloading = false,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const renderTaskRef = useRef<any>(null);

  const [pdfDoc, setPdfDoc] = useState<any>(null);
  const [numPages, setNumPages] = useState<number>(0);
  const [currentPage, setCurrentPage] = useState<number>(1);
  const [scale, setScale] = useState<number>(1.2);
  const [rotation, setRotation] = useState<number>(0);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [renderError, setRenderError] = useState<string | null>(null);
  const [pageInput, setPageInput] = useState<string>('1');
  const [showThumbnails, setShowThumbnails] = useState<boolean>(false);
  const [externalUrl, setExternalUrl] = useState<string | null>(null);

  // Set external URL for opening in a new tab if desired
  useEffect(() => {
    let url: string | null = null;
    if (pdfSource instanceof Blob) {
      url = URL.createObjectURL(pdfSource);
      setExternalUrl(url);
    } else if (typeof pdfSource === 'string') {
      setExternalUrl(pdfSource);
    } else {
      setExternalUrl(null);
    }

    return () => {
      if (url && pdfSource instanceof Blob) {
        URL.revokeObjectURL(url);
      }
    };
  }, [pdfSource]);

  // Load PDF Document
  useEffect(() => {
    let isCancelled = false;

    async function loadDocument() {
      if (!pdfSource) {
        setIsLoading(false);
        return;
      }

      setIsLoading(true);
      setRenderError(null);
      setPdfDoc(null);

      try {
        let loadingTask: any;

        if (pdfSource instanceof Blob) {
          const arrayBuffer = await pdfSource.arrayBuffer();
          loadingTask = pdfjsLib.getDocument({ data: new Uint8Array(arrayBuffer) });
        } else if (pdfSource instanceof ArrayBuffer) {
          loadingTask = pdfjsLib.getDocument({ data: new Uint8Array(pdfSource) });
        } else if (pdfSource instanceof Uint8Array) {
          loadingTask = pdfjsLib.getDocument({ data: pdfSource });
        } else if (typeof pdfSource === 'string') {
          if (pdfSource.startsWith('data:application/pdf')) {
            const base64 = pdfSource.split(',')[1] || pdfSource;
            const binaryStr = atob(base64.replace(/\s/g, ''));
            const len = binaryStr.length;
            const bytes = new Uint8Array(len);
            for (let i = 0; i < len; i++) {
              bytes[i] = binaryStr.charCodeAt(i);
            }
            loadingTask = pdfjsLib.getDocument({ data: bytes });
          } else {
            // URL string (e.g. /api/books/:id/pdf or https://...)
            loadingTask = pdfjsLib.getDocument({ url: pdfSource });
          }
        } else {
          throw new Error('صيغة ملف PDF غير مدعومة');
        }

        const doc = await loadingTask.promise;
        if (!isCancelled) {
          setPdfDoc(doc);
          setNumPages(doc.numPages);
          setCurrentPage(1);
          setPageInput('1');

          // Auto-fit initial scale based on container width
          if (containerRef.current) {
            const containerWidth = containerRef.current.clientWidth - 48;
            doc.getPage(1).then((page: any) => {
              if (isCancelled) return;
              const vp = page.getViewport({ scale: 1, rotation: 0 });
              if (vp.width > 0 && containerWidth > 0) {
                const fitScale = (containerWidth / vp.width) * 0.95;
                setScale(Math.max(0.6, Math.min(fitScale, 1.8)));
              }
            }).catch(() => {});
          }

          setIsLoading(false);
        }
      } catch (err: any) {
        if (!isCancelled) {
          console.error('Error loading PDF in Canvas viewer:', err);
          setRenderError(err.message || 'تعذر قراءة ملف الـ PDF');
          setIsLoading(false);
        }
      }
    }

    loadDocument();

    return () => {
      isCancelled = true;
    };
  }, [pdfSource]);

  // Render Page onto Canvas
  const renderPage = useCallback(async () => {
    if (!pdfDoc || !canvasRef.current) return;

    if (renderTaskRef.current) {
      try {
        renderTaskRef.current.cancel();
      } catch {
        // ignore cancel error
      }
    }

    try {
      const page = await pdfDoc.getPage(currentPage);
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      const viewport = page.getViewport({ scale, rotation });
      const pixelRatio = window.devicePixelRatio || 1;

      canvas.width = Math.floor(viewport.width * pixelRatio);
      canvas.height = Math.floor(viewport.height * pixelRatio);
      canvas.style.width = `${Math.floor(viewport.width)}px`;
      canvas.style.height = `${Math.floor(viewport.height)}px`;

      ctx.save();
      ctx.scale(pixelRatio, pixelRatio);

      const renderContext = {
        canvasContext: ctx,
        viewport,
      };

      const task = page.render(renderContext);
      renderTaskRef.current = task;
      await task.promise;
      ctx.restore();
    } catch (err: any) {
      if (err?.name !== 'RenderingCancelledException') {
        console.warn('Page rendering error:', err);
      }
    }
  }, [pdfDoc, currentPage, scale, rotation]);

  useEffect(() => {
    renderPage();
  }, [renderPage]);

  // Navigation handlers
  const handlePrevPage = () => {
    if (currentPage > 1) {
      const p = currentPage - 1;
      setCurrentPage(p);
      setPageInput(String(p));
      containerRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
    }
  };

  const handleNextPage = () => {
    if (currentPage < numPages) {
      const p = currentPage + 1;
      setCurrentPage(p);
      setPageInput(String(p));
      containerRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
    }
  };

  const handlePageInputSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const p = parseInt(pageInput, 10);
    if (!isNaN(p) && p >= 1 && p <= numPages) {
      setCurrentPage(p);
      containerRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
    } else {
      setPageInput(String(currentPage));
    }
  };

  const handleZoomIn = () => {
    setScale((prev) => Math.min(prev + 0.2, 3.0));
  };

  const handleZoomOut = () => {
    setScale((prev) => Math.max(prev - 0.2, 0.5));
  };

  const handleFitWidth = () => {
    if (!pdfDoc || !containerRef.current) return;
    pdfDoc.getPage(currentPage).then((page: any) => {
      const vp = page.getViewport({ scale: 1, rotation });
      const containerWidth = containerRef.current!.clientWidth - 48;
      if (vp.width > 0 && containerWidth > 0) {
        setScale(Math.max(0.5, Math.min(containerWidth / vp.width, 2.5)));
      }
    });
  };

  const handleRotate = () => {
    setRotation((prev) => (prev + 90) % 360);
  };

  return (
    <div className="flex-1 w-full h-full flex flex-col bg-stone-950 text-stone-200 select-none overflow-hidden">
      {/* Top Toolbar */}
      <div className="h-12 bg-stone-900 border-b border-stone-800 px-3 flex items-center justify-between gap-2 shrink-0 z-10">
        {/* Navigation Controls */}
        <div className="flex items-center gap-1.5">
          <button
            onClick={handlePrevPage}
            disabled={currentPage <= 1 || isLoading}
            className="p-1.5 rounded-lg bg-stone-800 hover:bg-stone-700 disabled:opacity-30 disabled:hover:bg-stone-800 text-stone-200 transition-colors"
            title="الصفحة السابقة"
          >
            <ChevronRight className="w-4 h-4" />
          </button>

          <form onSubmit={handlePageInputSubmit} className="flex items-center gap-1">
            <input
              type="text"
              value={pageInput}
              onChange={(e) => setPageInput(e.target.value)}
              onBlur={() => setPageInput(String(currentPage))}
              className="w-10 h-7 text-center text-xs font-mono bg-stone-950 border border-stone-700 rounded text-amber-300 focus:outline-none focus:border-amber-500"
            />
            <span className="text-xs text-stone-400 font-mono">/ {numPages || 1}</span>
          </form>

          <button
            onClick={handleNextPage}
            disabled={currentPage >= numPages || isLoading}
            className="p-1.5 rounded-lg bg-stone-800 hover:bg-stone-700 disabled:opacity-30 disabled:hover:bg-stone-800 text-stone-200 transition-colors"
            title="الصفحة التالية"
          >
            <ChevronLeft className="w-4 h-4" />
          </button>
        </div>

        {/* Zoom & View Controls */}
        <div className="flex items-center gap-1">
          <button
            onClick={handleZoomOut}
            disabled={isLoading || scale <= 0.6}
            className="p-1.5 rounded-lg bg-stone-800 hover:bg-stone-700 disabled:opacity-30 text-stone-200 transition-colors"
            title="تصغير"
          >
            <ZoomOut className="w-4 h-4" />
          </button>

          <span className="text-[11px] font-mono text-stone-400 min-w-[42px] text-center">
            {Math.round(scale * 100)}%
          </span>

          <button
            onClick={handleZoomIn}
            disabled={isLoading || scale >= 3.0}
            className="p-1.5 rounded-lg bg-stone-800 hover:bg-stone-700 disabled:opacity-30 text-stone-200 transition-colors"
            title="تكبير"
          >
            <ZoomIn className="w-4 h-4" />
          </button>

          <button
            onClick={handleFitWidth}
            disabled={isLoading}
            className="px-2 py-1 rounded-lg bg-stone-800 hover:bg-stone-700 text-stone-200 text-xs transition-colors hidden sm:inline-block"
            title="ملاءمة العرض"
          >
            ملء العرض
          </button>

          <button
            onClick={handleRotate}
            disabled={isLoading}
            className="p-1.5 rounded-lg bg-stone-800 hover:bg-stone-700 text-stone-200 transition-colors"
            title="تدوير الصفحة"
          >
            <RotateCw className="w-4 h-4" />
          </button>

          {numPages > 1 && (
            <button
              onClick={() => setShowThumbnails((prev) => !prev)}
              className={`p-1.5 rounded-lg border transition-colors ${
                showThumbnails
                  ? 'bg-amber-500/20 border-amber-500/50 text-amber-300'
                  : 'bg-stone-800 border-stone-700 hover:bg-stone-700 text-stone-300'
              }`}
              title="فهرس الصفحات السريع"
            >
              <Columns className="w-4 h-4" />
            </button>
          )}
        </div>

        {/* Action Controls */}
        <div className="flex items-center gap-1.5">
          {externalUrl && (
            <a
              href={externalUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="p-1.5 rounded-lg bg-stone-800 hover:bg-stone-700 text-stone-200 transition-colors hidden sm:flex items-center gap-1 text-xs"
              title="فتح في نافذة مستقلة"
            >
              <ExternalLink className="w-4 h-4" />
              <span className="hidden md:inline">نافذة جديدة</span>
            </a>
          )}

          {onDownload && (
            <button
              onClick={onDownload}
              disabled={isDownloading}
              className="p-1.5 rounded-lg bg-amber-600 hover:bg-amber-500 text-stone-950 font-medium transition-colors flex items-center gap-1 text-xs"
              title="تحميل نسخة PDF"
            >
              <Download className="w-4 h-4" />
              <span className="hidden sm:inline">تحميل PDF</span>
            </button>
          )}
        </div>
      </div>

      {/* Main View Area with Optional Quick Index */}
      <div className="flex-1 flex overflow-hidden relative">
        {/* Quick Page Index Drawer */}
        {showThumbnails && numPages > 1 && (
          <div className="w-36 sm:w-44 bg-stone-900/95 border-l border-stone-800 p-2 overflow-y-auto flex flex-col gap-1 z-10 shrink-0 select-none">
            <div className="text-[11px] font-bold text-amber-300 px-2 py-1 mb-1 border-b border-stone-800 flex items-center justify-between">
              <span>الفهرس السريع</span>
              <span className="font-mono text-stone-400">{numPages} ص</span>
            </div>
            {Array.from({ length: numPages }, (_, i) => i + 1).map((p) => (
              <button
                key={p}
                onClick={() => {
                  setCurrentPage(p);
                  setPageInput(String(p));
                  containerRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
                }}
                className={`px-2.5 py-1 rounded-md text-xs font-mono text-right transition-colors flex items-center justify-between ${
                  currentPage === p
                    ? 'bg-amber-600 text-stone-950 font-bold'
                    : 'bg-stone-950/60 hover:bg-stone-800 text-stone-300'
                }`}
              >
                <span>صفحة {p}</span>
                {currentPage === p && <span className="w-1.5 h-1.5 rounded-full bg-stone-950" />}
              </button>
            ))}
          </div>
        )}

        {/* Canvas Display Viewport */}
        <div
          ref={containerRef}
          className="flex-1 h-full overflow-auto p-4 flex flex-col items-center justify-start bg-stone-950"
        >
          {isLoading ? (
            <div className="flex-1 flex flex-col items-center justify-center p-8 text-stone-400">
              <Loader2 className="w-10 h-10 text-amber-500 animate-spin mb-3" />
              <p className="text-sm text-stone-300 font-medium">جاري معالجة وعرض صفحات الكتاب...</p>
              <p className="text-xs text-stone-500 mt-1">يتم الرسم المباشر بتقنية Canvas عالية الدقة</p>
            </div>
          ) : renderError ? (
            <div className="flex-1 flex flex-col items-center justify-center p-8 text-center max-w-md">
              <AlertCircle className="w-12 h-12 text-rose-500 mb-3" />
              <h4 className="text-base font-bold text-stone-200 mb-1">تعذر عرض صفحة الـ PDF</h4>
              <p className="text-xs text-stone-400 mb-4">{renderError}</p>
              {externalUrl && (
                <a
                  href={externalUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="px-4 py-2 rounded-xl bg-stone-800 hover:bg-stone-700 text-amber-300 text-xs font-semibold flex items-center gap-2"
                >
                  <ExternalLink className="w-4 h-4" />
                  <span>فتح الملف في نافذة مستقلة للمتصفح</span>
                </a>
              )}
            </div>
          ) : (
            <div className="shadow-2xl rounded-sm overflow-hidden bg-white my-auto max-w-full">
              <canvas ref={canvasRef} className="block mx-auto" />
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
