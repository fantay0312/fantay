export interface CanvasDocumentSummary {
  id: string;
  name: string;
  format: 'fig' | 'op';
  sha256: string;
  updatedAt: string;
}
export interface CanvasDocument extends CanvasDocumentSummary { data: string; }
