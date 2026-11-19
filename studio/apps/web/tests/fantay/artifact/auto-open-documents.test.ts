import { afterEach, describe, expect, it, vi } from 'vitest';

import { selectAutoOpenProducedArtifact } from '../../../src/components/auto-open-file';

const file = (name: string, mtime = 1) => ({ name, mtime });

describe('auto-open of office documents', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('leaves them to the produced-files chips in the inherited chrome', () => {
    vi.stubEnv('NEXT_PUBLIC_FANTAY_SHELL', '0');
    expect(selectAutoOpenProducedArtifact([file('deck.pptx'), file('notes.txt')])).toBeNull();
    expect(selectAutoOpenProducedArtifact([file('report.pdf')])).toBeNull();
  });

  it('opens a PDF, Word document, workbook or deck in the product shell', () => {
    vi.stubEnv('NEXT_PUBLIC_FANTAY_SHELL', '1');
    expect(selectAutoOpenProducedArtifact([file('deck.pptx'), file('notes.txt')])).toBe('deck.pptx');
    expect(selectAutoOpenProducedArtifact([file('report.pdf')])).toBe('report.pdf');
    expect(selectAutoOpenProducedArtifact([file('contract.docx')])).toBe('contract.docx');
    expect(selectAutoOpenProducedArtifact([file('budget.xlsx')])).toBe('budget.xlsx');
  });

  it('opens a Mermaid diagram or an Excalidraw drawing in the product shell only', () => {
    vi.stubEnv('NEXT_PUBLIC_FANTAY_SHELL', '1');
    expect(selectAutoOpenProducedArtifact([file('flow.mmd'), file('notes.txt')])).toBe('flow.mmd');
    expect(selectAutoOpenProducedArtifact([file('architecture.mermaid')])).toBe('architecture.mermaid');
    expect(selectAutoOpenProducedArtifact([file('sketch.excalidraw')])).toBe('sketch.excalidraw');
    vi.stubEnv('NEXT_PUBLIC_FANTAY_SHELL', '0');
    expect(selectAutoOpenProducedArtifact([file('flow.mmd')])).toBeNull();
    expect(selectAutoOpenProducedArtifact([file('sketch.excalidraw')])).toBeNull();
  });

  it('still prefers a web page, and stays level with a markdown report', () => {
    vi.stubEnv('NEXT_PUBLIC_FANTAY_SHELL', '1');
    expect(selectAutoOpenProducedArtifact([file('deck.pptx', 5), file('index.html', 1)])).toBe('index.html');
    // Same rank: the newer one wins.
    expect(selectAutoOpenProducedArtifact([file('report.md', 1), file('report.docx', 5)])).toBe('report.docx');
  });

  it('does not open legacy formats or delimited text', () => {
    vi.stubEnv('NEXT_PUBLIC_FANTAY_SHELL', '1');
    expect(selectAutoOpenProducedArtifact([file('old.doc')])).toBeNull();
    expect(selectAutoOpenProducedArtifact([file('old.ppt')])).toBeNull();
    expect(selectAutoOpenProducedArtifact([file('fixtures.csv')])).toBeNull();
  });
});
