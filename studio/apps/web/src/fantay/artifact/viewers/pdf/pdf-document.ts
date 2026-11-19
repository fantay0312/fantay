// SPDX-License-Identifier: AGPL-3.0-only
// Adapted from t3code apps/web/src/components/files/pdfDocument.ts @ c5e6b24f (MIT): one pdf.js
// worker shared by every document, and the `getDocument` call around it. Changed here: pdf.js is
// loaded on demand (never on the server), the worker and its data files are served by this app from
// /artifact/pdfjs/ instead of bundler globs, the hardening options are explicit, the worker is
// released once no document has used it for a while, a password is remembered for the session, and
// load errors are sorted into the states the viewer shows.
//
// A PDF is untrusted input. pdf.js parses it in a worker; nothing in the file is ever executed:
// no eval, no document scripting (the sandbox and its QuickJS build are not shipped), no XFA forms.
import type { PDFDocumentLoadingTask, PDFDocumentProxy, PDFWorker } from 'pdfjs-dist';

export type PdfModule = typeof import('pdfjs-dist');
export type { PDFDocumentLoadingTask, PDFDocumentProxy };

/**
 * Where the worker and its data live, copied from the installed `pdfjs-dist` (a test compares them
 * with the package so they cannot drift):
 *   pdf.worker.min.mjs   the parser, same version as the library
 *   cmaps/               character maps: without them Chinese, Japanese and Korean text is blank
 *   standard_fonts/      the 14 standard fonts for files that do not embed them
 *   wasm/                JPEG 2000 and JBIG2 image decoders, colour management
 *   iccs/                the CMYK colour profile
 */
export const PDF_ASSET_PATH = '/artifact/pdfjs/';

/** Larger images are scaled down in the worker before they are drawn (bytes of RGBA). */
const MAX_IMAGE_AREA_BYTES = 64 * 1024 * 1024;
/** An idle worker is kept this long, so switching between PDFs does not start a new one each time. */
const WORKER_IDLE_MS = 30_000;
const MAX_REMEMBERED_PASSWORDS = 20;

let modulePromise: Promise<PdfModule> | null = null;
let worker: PDFWorker | null = null;
let workerUsers = 0;
let workerTimer: ReturnType<typeof setTimeout> | null = null;

function assetUrl(path: string): string {
  return new URL(`${PDF_ASSET_PATH}${path}`, window.location.href).href;
}

/** pdf.js, loaded once. Call from an effect: the library needs a browser. */
export function loadPdfjs(): Promise<PdfModule> {
  modulePromise ??= import('pdfjs-dist').then(
    (pdfjs) => {
      pdfjs.GlobalWorkerOptions.workerSrc = assetUrl('pdf.worker.min.mjs');
      return pdfjs;
    },
    (error: unknown) => {
      // A failed chunk load must not poison every later attempt.
      modulePromise = null;
      throw error;
    },
  );
  return modulePromise;
}

function retainWorker(pdfjs: PdfModule): PDFWorker {
  if (workerTimer !== null) {
    clearTimeout(workerTimer);
    workerTimer = null;
  }
  if (!worker || worker.destroyed) worker = new pdfjs.PDFWorker({ verbosity: pdfjs.VerbosityLevel.ERRORS });
  workerUsers += 1;
  return worker;
}

function releaseWorker(): void {
  workerUsers = Math.max(0, workerUsers - 1);
  if (workerUsers > 0 || workerTimer !== null) return;
  workerTimer = setTimeout(() => {
    workerTimer = null;
    if (workerUsers > 0) return;
    worker?.destroy();
    worker = null;
  }, WORKER_IDLE_MS);
}

export interface OpenPdfOptions {
  /** A password to try first (one the reader typed earlier in this session). */
  password?: string;
}

export interface OpenedPdf {
  task: PDFDocumentLoadingTask;
  /** Destroys the document and gives the shared worker back. Safe to call more than once. */
  close(): void;
}

/**
 * Starts loading a PDF from its bytes. The bytes are copied: pdf.js hands its buffer to the worker,
 * and the viewer's copy has to survive a retry.
 */
export function openPdf(pdfjs: PdfModule, bytes: ArrayBuffer, options: OpenPdfOptions = {}): OpenedPdf {
  const shared = retainWorker(pdfjs);
  const parameters: Parameters<PdfModule['getDocument']>[0] & { isEvalSupported: false } = {
    data: new Uint8Array(bytes.slice(0)),
    worker: shared,
    password: options.password,
    verbosity: pdfjs.VerbosityLevel.ERRORS,
    cMapUrl: assetUrl('cmaps/'),
    cMapPacked: true,
    standardFontDataUrl: assetUrl('standard_fonts/'),
    wasmUrl: assetUrl('wasm/'),
    iccUrl: assetUrl('iccs/'),
    // pdf.js 6 has no code path that evaluates strings from a file (CVE-2024-4367 was that path).
    // The option is kept so an older pinned build could not bring it back.
    isEvalSupported: false,
    // XFA forms are HTML generated from the file; they stay off.
    enableXfa: false,
    canvasMaxAreaInBytes: MAX_IMAGE_AREA_BYTES,
  };
  const task = pdfjs.getDocument(parameters);
  let closed = false;
  return {
    task,
    close: () => {
      if (closed) return;
      closed = true;
      void task.destroy().catch(() => undefined);
      releaseWorker();
    },
  };
}

/* ── passwords ─────────────────────────────────────────────────────────────────────────────────── */

// Kept here and nowhere else: in memory for this session, so coming back to the tab does not ask
// again. Never written to storage, never part of the viewer's saved view state.
const passwords = new Map<string, string>();

export function rememberedPdfPassword(key: string): string | undefined {
  return passwords.get(key);
}

export function rememberPdfPassword(key: string, password: string): void {
  passwords.delete(key);
  passwords.set(key, password);
  if (passwords.size > MAX_REMEMBERED_PASSWORDS) {
    const oldest = passwords.keys().next().value;
    if (oldest !== undefined) passwords.delete(oldest);
  }
}

export function forgetPdfPassword(key: string): void {
  passwords.delete(key);
}

/* ── errors ────────────────────────────────────────────────────────────────────────────────────── */

/** Why a PDF did not open, as the viewer words it. */
export type PdfFailure =
  /** Not a PDF, or one too broken to read. */
  | 'damaged'
  /** A valid file with no pages, or no bytes at all. */
  | 'empty'
  /** Opening took longer than the viewer waits. */
  | 'slow'
  /** The library or its worker could not be loaded: nothing wrong with the file. */
  | 'unavailable';

/** Sorts a pdf.js error into a state. pdf.js names its exception classes; the message is never shown. */
export function classifyPdfError(error: unknown): PdfFailure {
  const name = typeof error === 'object' && error !== null && 'name' in error ? String((error as { name: unknown }).name) : '';
  const message = typeof error === 'object' && error !== null && 'message' in error ? String((error as { message: unknown }).message) : '';
  if (name === 'InvalidPDFException') return /empty|zero bytes/i.test(message) ? 'empty' : 'damaged';
  if (name === 'FormatError' || name === 'XRefParseException' || name === 'PasswordException') return 'damaged';
  if (name === 'ResponseException' || name === 'UnknownErrorException') return 'damaged';
  // A chunk or worker that failed to load, a version mismatch between library and worker.
  return 'unavailable';
}

/** True for the rejection pdf.js produces when a drawing or a text layer was cancelled on purpose. */
export function isPdfCancellation(error: unknown): boolean {
  const name = typeof error === 'object' && error !== null && 'name' in error ? String((error as { name: unknown }).name) : '';
  return name === 'RenderingCancelledException' || name === 'AbortException';
}
