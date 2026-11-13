import { describe, expect, it } from 'vitest';
import { studioAssetGroups } from '../../src/runtime/studio-assets';

describe('design system asset groups', () => {
  it('groups by the first folder under assets, merges the package folders, and orders a brand book', () => {
    const groups = studioAssetGroups([
      'assets/Icons/close.svg', 'assets/Logos/mark.svg', 'logos/wordmark.png', 'assets/studio/upload.png',
      'assets/readme.pdf', 'assets/Mascots/cube.webp', 'imagery/hero.jpg', 'assets/Imagery/clip.mp4',
      'fonts/brand.woff2', 'preview/cover.png', 'system/studio.json', 'tokens.css',
    ], false);
    expect(groups.map((group) => group.label)).toEqual(['Logos', 'Icons', 'Imagery', 'Mascots', 'Uploads', 'Other']);
    expect(groups[0]!.assets.map((asset) => asset.path)).toEqual(['assets/Logos/mark.svg', 'logos/wordmark.png']);
    expect(groups.find((group) => group.label === 'Imagery')!.assets.map((asset) => asset.kind)).toEqual(['video', 'image']);
    expect(groups.at(-1)!.assets).toEqual([{ path: 'assets/readme.pdf', name: 'readme.pdf', kind: 'file' }]);
  });
  it('names the known groups in Chinese and leaves a custom folder as written', () => {
    expect(studioAssetGroups(['assets/icons/a.svg', 'assets/Mascots/b.png', 'assets/c.png'], true).map((group) => group.label)).toEqual(['图标', 'Mascots', '其他']);
  });
  it('has nothing to show for a package without asset folders', () => {
    expect(studioAssetGroups(['tokens.css', 'DESIGN.md', 'preview/colors.html'], true)).toEqual([]);
  });
});
