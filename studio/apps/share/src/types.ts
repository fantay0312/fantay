export interface User { id: string; name: string }
export interface ShareFile { path: string; contentBase64: string; sha256: string }
export interface PublishInput { documentKey: string; title: string; files: ShareFile[]; requestKey: string; expectedRevision?: number }
export interface Target { selector?: string; label?: string; text?: string; position?: { x: number; y: number } }
export class HttpError extends Error { constructor(readonly status: number, message: string) { super(message); } }
