/** Browser-only PDF rendering. Call `dispose` when the source is replaced or unmounted. */

export type PdfWord = { t: string; x: number; y: number; w: number; h: number };
export type PdfPage = { page: number; width: number; height: number; image: string; words: PdfWord[] };
export type PdfLoadResult = {
  pages: PdfPage[];
  textPages: { page: number; text: string }[];
  /** Total pages in the source; only the first 40 are rendered. */
  pageCount: number;
  truncated: boolean;
  /** Pages without extractable text need OCR before text selection is possible. */
  ocrRequiredPages: number[];
  dispose: () => void;
};

const MAX_BYTES = 25 * 1024 * 1024;
const MAX_PAGES = 40;
const MAX_RENDER_DIMENSION = 1800;
const MAX_RENDER_PIXELS = MAX_RENDER_DIMENSION ** 2;
const MAX_PAGE_TEXT = 30_000;
// Reserve room for page separators/labels when the UI combines pages into source.text.
const MAX_SOURCE_TEXT = 990_000;
const MAX_WORDS_PER_PAGE = 5000;

function abortError(): DOMException {
  return new DOMException("PDF loading was cancelled", "AbortError");
}

function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, value));
}

/** @internal Keeps persisted page text within the workspace validator's limits. */
export function boundedPdfText(items: Array<{ str: string }>, remainingSourceChars: number): string {
  const limit = Math.max(0, Math.min(MAX_PAGE_TEXT, remainingSourceChars));
  let text = "";
  for (const item of items) {
    if (text.length >= limit) break;
    const part = item.str.replace(/\s+/gu, " ").trim();
    if (!part) continue;
    const prefix = text ? " " : "";
    const room = limit - text.length - prefix.length;
    if (room <= 0) break;
    let next = part.slice(0, room);
    // Avoid storing a dangling UTF-16 high surrogate at the truncation boundary.
    if (/[\uD800-\uDBFF]$/u.test(next)) next = next.slice(0, -1);
    text += prefix + next;
  }
  return text.trim();
}

function makeWords(
  items: Array<{ str: string; width: number; transform: number[]; dir?: string; fontName?: string }>,
  styles: Record<string, { fontFamily?: string }>,
  viewport: { width: number; height: number; scale: number; transform: number[] },
  measureContext: CanvasRenderingContext2D,
  transform: (a: number[], b: number[]) => number[],
): PdfWord[] {
  const words: PdfWord[] = [];
  for (const item of items) {
    if (words.length >= MAX_WORDS_PER_PAGE) break;
    if (!item.str.trim() || !item.transform || item.transform.length < 6) continue;
    if (item.str.length > MAX_PAGE_TEXT) continue;
    const tx = transform(viewport.transform, item.transform);
    const fontHeight = Math.hypot(tx[2], tx[3]);
    const axisLength = Math.hypot(tx[0], tx[1]);
    const itemWidth = item.width * viewport.scale;
    if (!fontHeight || !axisLength || !itemWidth) continue;

    measureContext.font = `${fontHeight}px ${styles[item.fontName ?? ""]?.fontFamily || "sans-serif"}`;
    const measuredWidth = measureContext.measureText(item.str).width || 1;
    const ux = tx[0] / axisLength;
    const uy = tx[1] / axisLength;
    const vx = tx[2] / fontHeight;
    const vy = tx[3] / fontHeight;
    const rtl = item.dir === "rtl";

    for (const match of item.str.matchAll(/\S+/gu)) {
      if (words.length >= MAX_WORDS_PER_PAGE) break;
      const token = match[0];
      const offset = measureContext.measureText(item.str.slice(0, match.index)).width / measuredWidth;
      const width = measureContext.measureText(token).width / measuredWidth * itemWidth;
      const along = (rtl ? 1 - offset - width / itemWidth : offset) * itemWidth;
      const baselineX = tx[4] + ux * along;
      const baselineY = tx[5] + uy * along;
      // A conservative font box around the baseline. This also handles rotated text.
      const corners = [
        [baselineX - vx * fontHeight * 0.2, baselineY - vy * fontHeight * 0.2],
        [baselineX + ux * width - vx * fontHeight * 0.2, baselineY + uy * width - vy * fontHeight * 0.2],
        [baselineX + vx * fontHeight * 0.8, baselineY + vy * fontHeight * 0.8],
        [baselineX + ux * width + vx * fontHeight * 0.8, baselineY + uy * width + vy * fontHeight * 0.8],
      ];
      const left = Math.max(0, Math.min(...corners.map(([x]) => x)));
      const top = Math.max(0, Math.min(...corners.map(([, y]) => y)));
      const right = Math.min(viewport.width, Math.max(...corners.map(([x]) => x)));
      const bottom = Math.min(viewport.height, Math.max(...corners.map(([, y]) => y)));
      if (right > left && bottom > top) {
        words.push({
          t: token,
          x: clampPercent(left / viewport.width * 100),
          y: clampPercent(top / viewport.height * 100),
          w: clampPercent((right - left) / viewport.width * 100),
          h: clampPercent((bottom - top) / viewport.height * 100),
        });
      }
    }
  }
  return words;
}

function canvasBlob(canvas: HTMLCanvasElement, signal?: AbortSignal): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (signal?.aborted) reject(abortError());
      else if (blob) resolve(blob);
      else reject(new Error("Could not render the PDF page image"));
    }, "image/webp", 0.85);
  });
}

export async function loadPdfPages(
  input: ArrayBuffer,
  options: { signal?: AbortSignal; onProgress?: (done: number, total: number) => void } = {},
): Promise<PdfLoadResult> {
  if (typeof window === "undefined") throw new Error("PDF rendering requires a browser");
  if (input.byteLength > MAX_BYTES) throw new Error("PDFs must be 25 MB or smaller");
  const { signal, onProgress } = options;
  checkAbort(signal);

  // Dynamic import keeps PDF.js and its worker out of server rendering.
  const pdfjs = await import("pdfjs-dist");
  checkAbort(signal);
  pdfjs.GlobalWorkerOptions.workerSrc = "/studio/pdf.worker.min.mjs";

  const task = pdfjs.getDocument({ data: new Uint8Array(input), isEvalSupported: false });
  const urls: string[] = [];
  let disposed = false;
  let activeRender: { cancel: () => void } | null = null;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    activeRender?.cancel();
    for (const url of urls) URL.revokeObjectURL(url);
    void Promise.resolve(task.destroy()).catch(() => undefined);
  };
  const onAbort = () => dispose();
  signal?.addEventListener("abort", onAbort, { once: true });

  try {
    checkAbort(signal);
    const document = await task.promise;
    checkAbort(signal);
    const total = Math.min(document.numPages, MAX_PAGES);
    const pages: PdfPage[] = [];
    const textPages: PdfLoadResult["textPages"] = [];
    const ocrRequiredPages: number[] = [];
    let sourceTextChars = 0;
    onProgress?.(0, total);

    for (let pageNumber = 1; pageNumber <= total; pageNumber++) {
      checkAbort(signal);
      const page = await document.getPage(pageNumber);
      try {
        const base = page.getViewport({ scale: 1 });
        if (!Number.isFinite(base.width) || !Number.isFinite(base.height) || base.width <= 0 || base.height <= 0) {
          throw new Error("The PDF page has invalid dimensions");
        }
        const scale = Math.min(1.5, MAX_RENDER_DIMENSION / Math.max(base.width, base.height));
        const viewport = page.getViewport({ scale });
        if (!Number.isFinite(viewport.width) || !Number.isFinite(viewport.height) ||
            viewport.width <= 0 || viewport.height <= 0 ||
            Math.ceil(viewport.width) * Math.ceil(viewport.height) > MAX_RENDER_PIXELS) {
          throw new Error("The PDF page exceeds the render limit");
        }
        const canvas = window.document.createElement("canvas");
        canvas.width = Math.max(1, Math.ceil(viewport.width));
        canvas.height = Math.max(1, Math.ceil(viewport.height));
        const context = canvas.getContext("2d", { alpha: false });
        if (!context) throw new Error("Canvas rendering is unavailable");
        try {
          const render = page.render({ canvasContext: context, viewport });
          activeRender = render;
          await render.promise;
          activeRender = null;
          checkAbort(signal);

          const content = await page.getTextContent();
          checkAbort(signal);
          const items = content.items.filter((item): item is Extract<typeof item, { str: string }> => "str" in item);
          const text = boundedPdfText(items, MAX_SOURCE_TEXT - sourceTextChars);
          sourceTextChars += text.length;
          const words = makeWords(items, content.styles, viewport, context, pdfjs.Util.transform);
          if (!items.some((item) => item.str.trim())) ocrRequiredPages.push(pageNumber);
          const blob = await canvasBlob(canvas, signal);
          checkAbort(signal);
          const image = URL.createObjectURL(blob);
          urls.push(image);
          pages.push({ page: pageNumber, width: viewport.width, height: viewport.height, image, words });
          textPages.push({ page: pageNumber, text });
          onProgress?.(pageNumber, total);
        } finally {
          canvas.width = 0;
          canvas.height = 0;
        }
      } finally {
        page.cleanup();
      }
    }

    signal?.removeEventListener("abort", onAbort);
    return { pages, textPages, pageCount: document.numPages, truncated: document.numPages > MAX_PAGES, ocrRequiredPages, dispose };
  } catch (error) {
    dispose();
    if (signal?.aborted) throw abortError();
    throw error;
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
}
