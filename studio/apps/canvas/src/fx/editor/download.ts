// SPDX-License-Identifier: Apache-2.0
/** Saves bytes as a download from the editor page (same-origin iframe, so downloads are allowed). */
export function downloadBytes(bytes: Uint8Array, fileName: string, mime: string): void {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const url = URL.createObjectURL(new Blob([copy.buffer], { type: mime }));
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.style.display = 'none';
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
