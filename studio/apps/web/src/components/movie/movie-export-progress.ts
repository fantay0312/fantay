/** Frame capture owns 90% of the progress meter; encoding and saving are separate stages. */
export function movieExportProgress(progress: string | undefined, done: boolean, zh: boolean): { value: number; label: string } {
  if (done) return { value: 98, label: zh ? '正在保存到所选位置…' : 'Saving to the selected location…' };
  const frames = /^Frames (\d+)\/(\d+)$/.exec(progress ?? '');
  if (frames && Number(frames[2]) > 0) {
    const value = Math.min(90, Math.floor(Number(frames[1]) / Number(frames[2]) * 90));
    return { value, label: zh ? `正在合成画面 · ${frames[1]} / ${frames[2]} 帧` : `Rendering frames · ${frames[1]} / ${frames[2]}` };
  }
  if (/Encod/i.test(progress ?? '')) return { value: 92, label: zh ? '正在编码视频…' : 'Encoding video…' };
  return { value: 0, label: zh ? '正在准备素材与渲染环境…' : 'Preparing assets and renderer…' };
}
