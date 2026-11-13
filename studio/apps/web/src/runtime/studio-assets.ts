// A design system's asset library, grouped the way Claude Design groups it: the first folder under
// `assets/` names the group (`assets/Logos/mark.svg` is a Logo), a file straight under `assets/` is
// Other, and the package's own `logos/` and `imagery/` folders join the group of the same name.
// Fonts, previews and system files are not assets here: they have their own sections.

export type StudioAssetKind = 'image' | 'video' | 'file';
export interface StudioAsset { path: string; name: string; kind: StudioAssetKind }
export interface StudioAssetGroup { key: string; label: string; assets: StudioAsset[] }

const IMAGE = /\.(png|jpe?g|gif|webp|avif|svg)$/i;
const VIDEO = /\.(mp4|webm|mov)$/i;

/** Known group names, in the order a brand book reads them; anything else follows alphabetically. */
const KNOWN: { keys: string[]; zh: string; en: string }[] = [
  { keys: ['logos', 'logo'], zh: 'Logo', en: 'Logos' },
  { keys: ['icons', 'icon'], zh: '图标', en: 'Icons' },
  { keys: ['illustrations', 'illustration'], zh: '插画', en: 'Illustrations' },
  { keys: ['imagery', 'images', 'photos', 'photography'], zh: '图片', en: 'Imagery' },
  { keys: ['textures', 'patterns', 'backgrounds'], zh: '纹理与背景', en: 'Textures' },
];
// Uploads from the studio land in assets/studio/; they and loose files close the list.
const UPLOADS = { keys: ['studio', 'uploads'], zh: '上传', en: 'Uploads' };
const OTHER = { zh: '其他', en: 'Other' };

function groupOf(path: string): string | null {
  const parts = path.split('/');
  if (parts[0] === 'logos' || parts[0] === 'imagery') return parts.length > 1 ? parts[0] : null;
  if (parts[0] !== 'assets' || parts.length < 2) return null;
  return parts.length === 2 ? '' : parts[1]!;
}

export function studioAssetGroups(files: string[], chinese: boolean): StudioAssetGroup[] {
  const groups = new Map<string, StudioAssetGroup>();
  for (const path of files) {
    const folder = groupOf(path);
    if (folder === null) continue;
    const lower = folder.toLowerCase();
    const known = KNOWN.find((item) => item.keys.includes(lower)) ?? (UPLOADS.keys.includes(lower) ? UPLOADS : null);
    const key = known ? known.keys[0]! : folder ? lower : '';
    const label = known ? (chinese ? known.zh : known.en) : folder || (chinese ? OTHER.zh : OTHER.en);
    const group = groups.get(key) ?? { key, label, assets: [] };
    group.assets.push({ path, name: path.split('/').pop() ?? path, kind: IMAGE.test(path) ? 'image' : VIDEO.test(path) ? 'video' : 'file' });
    groups.set(key, group);
  }
  const rank = (key: string) => {
    const known = KNOWN.findIndex((item) => item.keys[0] === key);
    return known >= 0 ? known : key === UPLOADS.keys[0] ? 900 : key === '' ? 901 : 100;
  };
  return Array.from(groups.values())
    .map((group) => ({ ...group, assets: group.assets.sort((a, b) => a.path.localeCompare(b.path)) }))
    .sort((a, b) => rank(a.key) - rank(b.key) || a.label.localeCompare(b.label));
}
