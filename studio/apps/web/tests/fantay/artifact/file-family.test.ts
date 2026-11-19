import { describe, expect, it } from 'vitest';

import { artifactExtension, artifactFileFamily, isPreviewableArtifact } from '../../../src/fantay/artifact/file-family';
import { fitZoom } from '../../../src/fantay/artifact/viewers/ImageViewer';
import { nextZoomStep } from '../../../src/fantay/artifact/shell/ArtifactZoom';
import { fileTabLabel } from '../../../src/fantay/workspace/tab-label';

describe('artifactExtension', () => {
  it('reads the last extension, lower-cased', () => {
    expect(artifactExtension('images/Photo.JPG')).toBe('jpg');
    expect(artifactExtension('a/b/report.final.pdf')).toBe('pdf');
  });

  it('keeps compound archive extensions together', () => {
    expect(artifactExtension('site.tar.gz')).toBe('tar.gz');
    expect(artifactExtension('backup.tar.zst')).toBe('tar.zst');
  });

  it('treats a leading dot and a bare name as no extension', () => {
    expect(artifactExtension('.gitignore')).toBe('');
    expect(artifactExtension('Makefile')).toBe('');
  });
});

describe('artifactFileFamily', () => {
  const viewerOf = (name: string, mime = ''): string => artifactFileFamily(name, mime).viewer;
  const formatOf = (name: string, mime = ''): string => artifactFileFamily(name, mime).format;

  it('sends the files the daemon calls binary to real viewers', () => {
    // Every one of these was "Binary file (N bytes)" before.
    expect(viewerOf('data/orders.csv')).toBe('sheet');
    expect(viewerOf('config.yaml')).toBe('text');
    expect(viewerOf('main.go')).toBe('text');
    expect(viewerOf('query.sql')).toBe('text');
    expect(viewerOf('app.log')).toBe('text');
    expect(viewerOf('scan.tiff')).toBe('image');
    expect(viewerOf('photo.heic')).toBe('image');
    expect(viewerOf('design.psd')).toBe('image');
    expect(viewerOf('contract.rtf')).toBe('document');
    expect(viewerOf('book.epub')).toBe('ebook');
    expect(viewerOf('bundle.zip')).toBe('archive');
    expect(viewerOf('model.glb')).toBe('model');
    expect(viewerOf('font.woff2')).toBe('font');
    expect(viewerOf('orders.sqlite')).toBe('database');
    expect(viewerOf('analysis.ipynb')).toBe('notebook');
  });

  it('names how the bytes have to be read', () => {
    expect(formatOf('a.png')).toBe('native');
    expect(formatOf('a.svg')).toBe('svg');
    expect(formatOf('a.heif')).toBe('heic');
    expect(formatOf('a.docx')).toBe('docx');
    expect(formatOf('a.doc')).toBe('legacy');
    expect(formatOf('a.xls')).toBe('workbook');
    expect(formatOf('a.tsv')).toBe('tsv');
    expect(formatOf('a.pptx')).toBe('pptx');
    expect(formatOf('a.key')).toBe('legacy');
    expect(formatOf('a.tgz')).toBe('tar.gz');
    expect(formatOf('a.tar.gz')).toBe('tar.gz');
    expect(formatOf('a.7z')).toBe('unsupported');
    expect(formatOf('a.avi')).toBe('unsupported');
  });

  it('gives diagrams, drawings and mail viewers of their own', () => {
    expect(artifactFileFamily('docs/flow.mmd')).toMatchObject({ viewer: 'diagram', format: 'mermaid' });
    expect(artifactFileFamily('docs/flow.mermaid')).toMatchObject({ viewer: 'diagram', format: 'mermaid' });
    // An Excalidraw scene is JSON on disk and a drawing to a person, whatever MIME the server guessed.
    expect(artifactFileFamily('notes/sketch.excalidraw', 'application/json')).toMatchObject({ viewer: 'whiteboard', family: 'image', format: 'excalidraw' });
    expect(artifactFileFamily('inbox/message.eml')).toMatchObject({ viewer: 'email', family: 'document', format: 'eml' });
  });

  it('keeps TypeScript out of the video family', () => {
    expect(viewerOf('src/app.ts')).toBe('text');
    expect(viewerOf('src/module.mts')).toBe('text');
    expect(artifactFileFamily('src/app.ts').family).toBe('code');
  });

  it('keeps a Word template a document, not a Graphviz source', () => {
    expect(viewerOf('letter.dot')).toBe('document');
    expect(viewerOf('graph.gv')).toBe('text');
  });

  it('recognises well-known names without an extension', () => {
    expect(viewerOf('Dockerfile')).toBe('text');
    expect(viewerOf('Makefile')).toBe('text');
    expect(viewerOf('LICENSE')).toBe('text');
    expect(viewerOf('docs/README')).toBe('text');
    expect(viewerOf('.gitignore')).toBe('text');
    expect(viewerOf('.env.production')).toBe('text');
  });

  it('prefers a known extension over the MIME type', () => {
    expect(viewerOf('main.py', 'text/plain')).toBe('text');
    expect(artifactFileFamily('main.py', 'text/plain').family).toBe('code');
    expect(viewerOf('data.csv', 'application/octet-stream')).toBe('sheet');
  });

  it('falls back to the MIME type, then to the file card', () => {
    expect(viewerOf('blob', 'image/png')).toBe('image');
    expect(viewerOf('blob', 'application/pdf')).toBe('pdf');
    expect(viewerOf('notes', 'text/plain; charset=utf-8')).toBe('text');
    expect(viewerOf('payload.bin', 'application/octet-stream')).toBe('unknown');
    expect(viewerOf('weird.xyz')).toBe('unknown');
    expect(isPreviewableArtifact('weird.xyz')).toBe(false);
    expect(isPreviewableArtifact('report.pdf')).toBe(true);
  });

  it('reads the name from any folder depth and either slash', () => {
    expect(viewerOf('a/b/c/deck.pptx')).toBe('slides');
    expect(viewerOf('a\\b\\c\\deck.pptx')).toBe('slides');
  });
});

describe('fitZoom', () => {
  it('shows the whole picture inside the padding and never enlarges it', () => {
    expect(fitZoom({ width: 2000, height: 1000 }, { width: 1048, height: 800 }, 24)).toBeCloseTo(0.5);
    expect(fitZoom({ width: 1000, height: 2000 }, { width: 1048, height: 1048 }, 24)).toBeCloseTo(0.5);
    expect(fitZoom({ width: 64, height: 64 }, { width: 800, height: 600 }, 24)).toBe(1);
  });

  it('stays positive for a stage that has no size yet', () => {
    expect(fitZoom({ width: 960, height: 640 }, { width: 0, height: 0 }, 24)).toBeGreaterThan(0);
    expect(fitZoom({ width: 0, height: 0 }, { width: 800, height: 600 }, 24)).toBe(1);
  });
});

describe('nextZoomStep', () => {
  it('walks the stops in both directions', () => {
    expect(nextZoomStep(1, 1, 0.1, 8)).toBe(1.25);
    expect(nextZoomStep(1, -1, 0.1, 8)).toBe(0.75);
    expect(nextZoomStep(0.69, 1, 0.1, 8)).toBe(0.75);
    expect(nextZoomStep(0.69, -1, 0.1, 8)).toBe(0.67);
  });

  it('skips a stop that reads as the percentage already shown', () => {
    // Fitted at 66.6% the control says 67%; one step has to change what it says.
    expect(nextZoomStep(0.666, 1, 0.1, 8)).toBe(0.75);
    expect(nextZoomStep(0.674, -1, 0.1, 8)).toBe(0.5);
    expect(nextZoomStep(0.996, 1, 0.1, 8)).toBe(1.25);
  });

  it('stops at the range', () => {
    expect(nextZoomStep(8, 1, 0.1, 8)).toBe(8);
    expect(nextZoomStep(0.1, -1, 0.1, 8)).toBe(0.1);
    expect(nextZoomStep(3.5, 1, 0.1, 4)).toBe(4);
  });
});

describe('fileTabLabel', () => {
  it('shows the file name alone', () => {
    expect(fileTabLabel('images/poster.png', ['images/poster.png', 'report.md'])).toBe('poster.png');
    expect(fileTabLabel('report.md', ['report.md'])).toBe('report.md');
  });

  it('keeps the parent folder when two open files share a name', () => {
    const open = ['web/index.html', 'docs/index.html'];
    expect(fileTabLabel('web/index.html', open)).toBe('web/index.html');
    expect(fileTabLabel('a/b/docs/index.html', ['a/b/docs/index.html', 'web/index.html'])).toBe('docs/index.html');
  });
});
