import sharp from 'sharp';

/** CDP tags screenshots with the display ICC profile; FFmpeg ignores it. */
export async function normalizeFramePng(bytes: Buffer): Promise<Buffer> {
  return sharp(bytes).toColourspace('srgb').png().toBuffer();
}
