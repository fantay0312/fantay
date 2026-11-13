// Every non-colour token group drawn as itself: type at true size, gaps at true width, shadows on
// the system's own ground. Values arrive resolved for the previewed theme and go into inline
// styles, so a design system's own variable names never reach the app's chrome.
import { createContext, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ButtonHTMLAttributes, type CSSProperties, type ReactNode, type RefObject } from 'react';
import { resolveStudioToken, type StudioDocument, type StudioToken, type StudioTokenGroup } from '@open-design/contracts';
import { contrastRatio, parseStudioColor, studioPalette, studioTokenLabel, studioTokenNote } from '../runtime/studio-palette';
import { studioTokenLine } from '../runtime/studio-token-edit';
import styles from './StudioSpecimens.module.css';

type SpecimenGroup = Exclude<StudioTokenGroup, 'colors'>;

interface Props {
  group: SpecimenGroup; tokens: StudioToken[]; scope: string;
  notes: StudioDocument['tokenNotes']; chinese: boolean;
  selected: string | null; onSelect: (name: string | null) => void;
}
interface Item { name: string; value: string; label: string; px: number | null }
interface System { ground: string; ink: string; surface: string; stage: string; line: string; display: string; body: string; tracking: string | null }
interface SpecimenProps { items: Item[]; system: System; selected: string | null; toggle: (name: string) => void; chinese: boolean }

interface TokenCopy { zh: string; en: string; noteZh: string; noteEn: string }
// All presets share this schema, so its slots can be named properly instead of echoing the variable.
const COPY: Record<string, TokenCopy> = {
  '--font-display': { zh: '标题字体', en: 'Display', noteZh: '标题与大字', noteEn: 'Headlines and large type' },
  '--font-body': { zh: '正文字体', en: 'Body', noteZh: '连续阅读与界面文字', noteEn: 'Running text and interface labels' },
  '--font-mono': { zh: '等宽字体', en: 'Mono', noteZh: '代码，以及需要对齐的数字', noteEn: 'Code, and numbers that must align' },
  '--leading-body': { zh: '正文行高', en: 'Body leading', noteZh: '连续阅读的文字', noteEn: 'Running text' },
  '--leading-tight': { zh: '紧凑行高', en: 'Tight leading', noteZh: '标题与界面控件', noteEn: 'Headlines and controls' },
  '--tracking-display': { zh: '标题字距', en: 'Display tracking', noteZh: '大字号的字间距', noteEn: 'Letter spacing at large sizes' },
  '--radius-sm': { zh: '小圆角', en: 'Small', noteZh: '小控件与标记', noteEn: 'Small controls and marks' },
  '--radius-md': { zh: '中圆角', en: 'Medium', noteZh: '输入框与卡片', noteEn: 'Inputs and cards' },
  '--radius-lg': { zh: '大圆角', en: 'Large', noteZh: '面板与大卡片', noteEn: 'Panels and large cards' },
  '--radius-pill': { zh: '胶囊', en: 'Pill', noteZh: '按钮与标签', noteEn: 'Buttons and tags' },
  '--elev-flat': { zh: '平面', en: 'Flat', noteZh: '贴在底色上，没有投影', noteEn: 'Sits on the ground, no shadow' },
  '--elev-ring': { zh: '描边环', en: 'Ring', noteZh: '不占位的 1px 边界', noteEn: 'An edge that takes no layout space' },
  '--elev-raised': { zh: '抬升', en: 'Raised', noteZh: '浮层、菜单与弹出面板', noteEn: 'Overlays, menus and popovers' },
  '--focus-ring': { zh: '焦点环', en: 'Focus ring', noteZh: '键盘焦点的标记', noteEn: 'Marks keyboard focus' },
  '--motion-fast': { zh: '快', en: 'Fast', noteZh: '微交互与退出', noteEn: 'Micro-states and exits' },
  '--motion-base': { zh: '基准', en: 'Base', noteZh: '进入与状态切换', noteEn: 'Entrances and state changes' },
  '--motion-slow': { zh: '慢', en: 'Slow', noteZh: '大范围的布局变化', noteEn: 'Large layout moves' },
  '--ease-standard': { zh: '标准缓动', en: 'Standard ease', noteZh: '界面过渡的默认曲线', noteEn: 'The default curve for transitions' },
  '--container-max': { zh: '内容上限', en: 'Max width', noteZh: '内容列的最大宽度', noteEn: 'The widest the content column gets' },
  '--container-gutter-desktop': { zh: '桌面边距', en: 'Desktop gutter', noteZh: '内容列到页面边缘的距离', noteEn: 'From the content column to the page edge' },
  '--container-gutter-tablet': { zh: '平板边距', en: 'Tablet gutter', noteZh: '内容列到页面边缘的距离', noteEn: 'From the content column to the page edge' },
  '--container-gutter-phone': { zh: '手机边距', en: 'Phone gutter', noteZh: '内容列到页面边缘的距离', noteEn: 'From the content column to the page edge' },
  '--section-y-desktop': { zh: '桌面分区', en: 'Desktop section', noteZh: '上下两个分区之间的距离', noteEn: 'Between two stacked sections' },
  '--section-y-tablet': { zh: '平板分区', en: 'Tablet section', noteZh: '上下两个分区之间的距离', noteEn: 'Between two stacked sections' },
  '--section-y-phone': { zh: '手机分区', en: 'Phone section', noteZh: '上下两个分区之间的距离', noteEn: 'Between two stacked sections' },
  '--measure-prose': { zh: '长文行宽', en: 'Prose', noteZh: '长篇正文', noteEn: 'Long-form body text' },
  '--measure-narrow': { zh: '窄行宽', en: 'Narrow', noteZh: '表单、对话框与卡片摘要', noteEn: 'Forms, dialogs and card summaries' },
  '--measure-cjk': { zh: '中文行宽', en: 'CJK', noteZh: '中文正文，每行约 36 字；WCAG 1.4.8 建议每行不超过 40 个汉字', noteEn: 'Chinese body text, about 36 characters a line; WCAG 1.4.8 suggests at most 40 CJK glyphs' },
  '--icon-size-sm': { zh: '小图标', en: 'Small icon', noteZh: '行内文字与紧凑控件里的图标', noteEn: 'Icons in running text and compact controls' },
  '--icon-size-md': { zh: '中图标', en: 'Medium icon', noteZh: '按钮与菜单里的默认图标', noteEn: 'The default icon in buttons and menus' },
  '--icon-size-lg': { zh: '大图标', en: 'Large icon', noteZh: '工具栏与空状态', noteEn: 'Toolbars and empty states' },
  '--control-height-sm': { zh: '小控件', en: 'Small control', noteZh: '紧凑工具栏与表格里的按钮、输入框', noteEn: 'Buttons and inputs in dense toolbars and tables' },
  '--control-height-md': { zh: '中控件', en: 'Medium control', noteZh: '按钮与输入框的默认高度', noteEn: 'The default height for buttons and inputs' },
  '--control-height-lg': { zh: '大控件', en: 'Large control', noteZh: '主要操作与触屏表单', noteEn: 'Primary actions and touch forms' },
  '--target-min': { zh: '最小点击目标', en: 'Minimum target', noteZh: 'WCAG 2.5.8 AA：指针目标至少 24×24 CSS 像素', noteEn: 'WCAG 2.5.8 AA: pointer targets at least 24×24 CSS px' },
  '--target-comfort': { zh: '舒适触控目标', en: 'Comfortable target', noteZh: '手指容易按中的尺寸，对应 WCAG 2.5.5 AAA 的 44×44', noteEn: 'Easy to hit with a finger; WCAG 2.5.5 AAA asks for 44×44' },
  '--aspect-square': { zh: '方形', en: 'Square', noteZh: '头像与缩略图', noteEn: 'Avatars and thumbnails' },
  '--aspect-photo': { zh: '照片', en: 'Photo', noteZh: '3:2 照片与卡片配图', noteEn: '3:2 photos and card images' },
  '--aspect-video': { zh: '视频', en: 'Video', noteZh: '16:9 视频与宽幅封面', noteEn: '16:9 video and wide covers' },
  '--aspect-portrait': { zh: '竖幅', en: 'Portrait', noteZh: '3:4 人像与竖图', noteEn: '3:4 portraits and tall images' },
};

// Systems outside the schema still follow its families, so a suffix keeps the word for the family.
const FAMILIES: [RegExp, string, string][] = [
  [/^--text-([\w-]+)$/, '字号', 'Size'], [/^--space-([\w-]+)$/, '间距', 'Space'], [/^--(?:shadow|elev)-([\w-]+)$/, '阴影', 'Shadow'],
  [/^--radius-([\w-]+)$/, '圆角', 'Radius'], [/^--(?:motion|duration)-([\w-]+)$/, '时长', 'Duration'], [/^--ease-([\w-]+)$/, '缓动', 'Ease'],
  [/^--leading-([\w-]+)$/, '行高', 'Leading'], [/^--tracking-([\w-]+)$/, '字距', 'Tracking'], [/^--font-weight-([\w-]+)$/, '字重', 'Weight'],
  [/^--font-size-([\w-]+)$/, '字号', 'Size'], [/^--z-([\w-]+)$/, '层级', 'Layer'], [/^--measure-([\w-]+)$/, '行宽', 'Measure'],
  [/^--container-([\w-]+)$/, '容器', 'Container'], [/^--breakpoint-([\w-]+)$/, '断点', 'Breakpoint'], [/^--grid-([\w-]+)$/, '栅格', 'Grid'],
  [/^--icon-(?:size-)?([\w-]+)$/, '图标', 'Icon'], [/^--(?:control|button|input)-(?:height|size)-([\w-]+)$/, '控件高度', 'Control'],
  [/^--(?:target|touch|tap)-(?:size-)?([\w-]+)$/, '点击目标', 'Target'], [/^--avatar-(?:size-)?([\w-]+)$/, '头像', 'Avatar'],
  [/^--(?:aspect-ratio|aspect|ratio)-([\w-]+)$/, '比例', 'Ratio'], [/^--(?:base-)?(?:size|sizing)-([\w-]+)$/, '尺寸', 'Size'],
  [/^--font-([\w-]+)$/, '字体', 'Family'],
];

const slug = (name: string) => name.replace(/^--/, '');

export function specimenTokenLabel(name: string, chinese: boolean): string {
  const copy = COPY[name];
  if (copy) return chinese ? copy.zh : copy.en;
  for (const [pattern, zh, en] of FAMILIES) {
    const rest = pattern.exec(name)?.[1];
    if (rest) return (chinese ? zh : en) + ' ' + (rest.length <= 3 ? rest.toUpperCase() : rest.replace(/-/g, ' '));
  }
  return studioTokenLabel(name, chinese);
}
export function specimenTokenNote(name: string, notes: StudioDocument['tokenNotes'], chinese: boolean): string {
  const own = studioTokenNote(name, notes, chinese);
  if (own) return own;
  const copy = COPY[name];
  return copy ? (chinese ? copy.noteZh : copy.noteEn) : '';
}

const isRing = (name: string) => /(^|-)ring(-|$)/.test(name);
const isSection = (name: string) => /^--section(-|$)/.test(name);

/**
 * The tokens drawn in a group. The parser files --focus-ring and --section-y-* under `other`, yet
 * they read as a shadow and as a gap, so they are drawn there and `other` keeps only the rest.
 */
export function studioSpecimenNames(group: SpecimenGroup, tokens: StudioToken[]): string[] {
  const inGroup = (target: StudioTokenGroup) => Array.from(new Set(tokens.filter((token) => token.group === target).map((token) => token.name)));
  const other = inGroup('other');
  if (group === 'shadows') return [...inGroup('shadows'), ...other.filter(isRing)];
  if (group === 'layout') return [...inGroup('layout'), ...other.filter(isSection)];
  if (group === 'other') return other.filter((name) => !isRing(name) && !isSection(name));
  return inGroup(group);
}

/** Pixels for a plain length; null for anything the browser has to compute, such as clamp(). */
function pxOf(value: string): number | null {
  const match = /^(-?\d*\.?\d+)(px|rem|em)?$/.exec(value.trim());
  if (!match) return null;
  return Number(match[1]) * (match[2] === 'rem' || match[2] === 'em' ? 16 : 1);
}
function durationOf(value: string): number | null {
  const match = /(?:^|\s)(\d*\.?\d+)(ms|s)(?=\s|$)/.exec(value.trim());
  return match ? Number(match[1]) * (match[2] === 's' ? 1000 : 1) : null;
}
const EASE_WORDS: Record<string, [number, number, number, number]> = {
  linear: [0, 0, 1, 1], ease: [0.25, 0.1, 0.25, 1], 'ease-in': [0.42, 0, 1, 1], 'ease-out': [0, 0, 0.58, 1], 'ease-in-out': [0.42, 0, 0.58, 1],
};
function bezierOf(value: string): [number, number, number, number] | null {
  const inner = /cubic-bezier\(([^)]*)\)/.exec(value)?.[1];
  if (inner !== undefined) {
    const points = inner.split(',').map(Number);
    // x outside 0..1 is invalid CSS and would make the Web Animations call throw.
    const valid = points.length === 4 && points.every(Number.isFinite) && points[0]! >= 0 && points[0]! <= 1 && points[2]! >= 0 && points[2]! <= 1;
    return valid ? points as [number, number, number, number] : null;
  }
  return EASE_WORDS[value.trim()] ?? null;
}
// An uploaded font is named after its file: 'AlbertSans-VariableFont_wght'.
const FILE_FAMILY = /[-_]?(VariableFont|Variable)(?=$|[-_]).*$|[-_](wght|ital|opsz|wdth)(?=$|[-_]).*$|[-_](Regular|Roman)$/i;
function familyName(value: string, chinese: boolean): string {
  const first = value.split(',')[0]?.trim().replace(/^["']|["']$/g, '') ?? '';
  if (/^(-apple-system|system-ui|BlinkMacSystemFont)$/.test(first)) return chinese ? '系统字体' : 'System';
  if (first === 'ui-monospace') return chinese ? '系统等宽' : 'System mono';
  // Only a file-style name is split at its capitals; 'BMWTypeNext' is a family as written.
  if (!/\s/.test(first) && FILE_FAMILY.test(first)) {
    const plain = first.replace(FILE_FAMILY, '').replace(/[-_]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').trim();
    if (plain) return plain;
  }
  return first || value;
}
// Roles the studio names itself; any other family token (an upload, say) is labelled as such.
const FAMILY_ROLE = /^--font-(display|heading|head|body|text|sans|serif|mono|code|ui|base|brand)(-|$)/;
const motionAllowed = () => typeof window !== 'undefined' && !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

function systemOf(tokens: StudioToken[], scope: string, notes: StudioDocument['tokenNotes'], chinese: boolean): System {
  const palette = studioPalette(tokens, scope, notes, chinese);
  const read = (name: string) => resolveStudioToken(name, tokens, scope);
  const { ground, ink } = palette;
  const surface = read('--surface') ?? ground;
  const tray = read('--surface-warm') ?? surface;
  // A card needs a ground it can be told apart from, or the flat level disappears. Many surfaces
  // sit a hair off the page, so the test is measured, not string equality.
  const apart = (color: string) => {
    const [a, b] = [parseStudioColor(color), parseStudioColor(ground)];
    return Boolean(a && b) && contrastRatio(a!.rgb, b!.rgb) >= 1.06;
  };
  const stage = [surface, tray].find(apart) ?? `color-mix(in srgb, ${ink} 6%, ${ground})`;
  return {
    ground, ink, surface, stage,
    line: read('--border-soft') ?? read('--border') ?? `color-mix(in srgb, ${ink} 14%, ${ground})`,
    display: read('--font-display') ?? read('--font-body') ?? 'inherit',
    body: read('--font-body') ?? 'inherit',
    tracking: read('--tracking-display'),
  };
}

export function StudioSpecimens({ group, tokens, scope, notes, chinese, selected, onSelect }: Props) {
  const system = useMemo(() => systemOf(tokens, scope, notes, chinese), [tokens, scope, notes, chinese]);
  const items = useMemo(() => studioSpecimenNames(group, tokens).map((name): Item => {
    const value = studioTokenLine(resolveStudioToken(name, tokens, scope) ?? '');
    return { name, value, label: specimenTokenLabel(name, chinese), px: pxOf(value) };
  }), [group, tokens, scope, chinese]);
  const props: SpecimenProps = { items, system, selected, chinese, toggle: (name) => onSelect(selected === name ? null : name) };
  if (!items.length) {
    return <p className={styles.empty}>{group === 'other'
      ? (chinese ? '焦点环和分区间距已归入阴影与布局。' : 'The focus ring and section spacing live under Shadows and Layout.')
      : (chinese ? '这一组还没有设计变量。' : 'No tokens in this group yet.')}</p>;
  }
  const ground = { '--sp-ground': system.ground, '--sp-ink': system.ink, '--sp-surface': system.surface, '--sp-stage': system.stage, '--sp-line': system.line } as CSSProperties;
  return <div className={styles.root} style={ground} data-group={group}>
    {group === 'typography' && <Typography {...props} />}
    {group === 'spacing' && <Spacing {...props} />}
    {group === 'radius' && <Radius {...props} />}
    {group === 'shadows' && <Shadows {...props} />}
    {group === 'motion' && <Motion {...props} />}
    {group === 'layout' && <Layout {...props} />}
    {group === 'measure' && <Measure {...props} />}
    {group === 'sizing' && <Sizing {...props} />}
    {group === 'layers' && <Layers {...props} />}
    {group === 'other' && <Compact {...props} />}
  </div>;
}

type TileProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'type'> & { item: Item; selected: string | null; toggle: (name: string) => void };
// The tile's name is the token itself; its visible caption (label, scaled value, hint) is what a
// sighted reader sees, so the caption becomes the tile's description once one is drawn inside it.
const CaptionSlot = createContext<{ id: string; mount: () => void } | null>(null);
function Tile({ item, selected, toggle, className, children, onClick, ...rest }: TileProps) {
  const captionId = useId();
  const [described, setDescribed] = useState(false);
  const slot = useMemo(() => ({ id: captionId, mount: () => setDescribed(true) }), [captionId]);
  return <button
    {...rest} type="button" className={styles.tile + (className ? ' ' + className : '')}
    aria-pressed={selected === item.name} aria-label={item.name + ' ' + (item.value || '—')} aria-describedby={described ? captionId : undefined} data-token={item.name}
    onClick={(event) => { onClick?.(event); toggle(item.name); }}
  ><CaptionSlot.Provider value={slot}>{children}</CaptionSlot.Provider></button>;
}
function Caption({ item, value, hint }: { item: Item; value?: string; hint?: string }) {
  const slot = useContext(CaptionSlot);
  useLayoutEffect(() => { slot?.mount(); }, [slot]);
  return <span className={styles.caption} id={slot?.id}>
    <span className={styles.captionName}>{item.label}</span>
    <span className={styles.captionValue}>{value ?? (item.value || '—')}</span>
    {hint && <span className={styles.captionHint}>{hint}</span>}
  </span>;
}
function Block({ title, hint, children }: { title?: string; hint?: string; children: ReactNode }) {
  return <section className={styles.block}>
    {title && <header className={styles.blockHead}><h3>{title}</h3>{hint && <span>{hint}</span>}</header>}
    {children}
  </section>;
}
const shared = ({ selected, toggle }: SpecimenProps) => ({ selected, toggle });

type TypeKind = 'family' | 'size' | 'leading' | 'tracking' | 'weight';
function typeKind(name: string): TypeKind {
  if (/weight/.test(name)) return 'weight';
  if (/line-height|leading/.test(name)) return 'leading';
  if (/letter-spacing|tracking/.test(name)) return 'tracking';
  if (/size|^--text-/.test(name)) return 'size';
  return 'family';
}
const CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ abcdefghijklmnopqrstuvwxyz 0123456789 永和九年岁在癸丑暮春之初';
const CHARS_MONO = '0O 1lI {}[]() => != <= 0123456789 永和九年';

function Typography(props: SpecimenProps) {
  const { items, system, chinese } = props;
  const of = (kind: TypeKind) => items.filter((item) => typeKind(item.name) === kind);
  const sizes = of('size').sort((a, b) => (b.px ?? 0) - (a.px ?? 0));
  const leadings = of('leading'), trackings = of('tracking'), weights = of('weight');
  const sample = chinese ? '字号决定节奏 Type scale' : 'Type sets the pace';
  const paragraph = chinese ? '设计系统把一次次决定写成规则，下一个页面才不用从头再想。好的行高让眼睛顺利回到下一行的开头。' : 'A design system writes decisions down, so the next page does not start from zero. Good leading carries the eye back to the next line.';
  return <>
    <Block title={chinese ? '字体' : 'Families'}>
      <div className={styles.families}>
        {of('family').map((item) => {
          const mono = /mono|code/.test(item.name);
          const display = /display|head/.test(item.name);
          const face: CSSProperties = { fontFamily: item.value || undefined };
          return <Tile key={item.name} item={item} {...shared(props)} className={styles.family} title={item.value}>
            <span className={styles.familyHead}><span>{FAMILY_ROLE.test(item.name) || !/^--font-/.test(item.name) ? item.label : chinese ? '其他字体' : 'Other font'}</span><span className={styles.mono}>{slug(item.name)}</span></span>
            <span className={styles.familyStage}><span className={styles.familyGlyph} style={{ ...face, fontWeight: display ? 600 : 400, letterSpacing: display ? system.tracking ?? undefined : undefined }}>Aa 永</span></span>
            <span className={styles.familyFoot} style={face}>
              <span className={styles.familyName}>{familyName(item.value, chinese)}</span>
              <span className={styles.familyChars}>{mono ? CHARS_MONO : CHARS}</span>
            </span>
          </Tile>;
        })}
      </div>
    </Block>
    {sizes.length > 0 && <Block title={chinese ? '字号' : 'Sizes'}>
      <div className={styles.panel}>
        {sizes.map((item) => {
          const large = (item.px ?? 0) >= 20;
          return <Tile key={item.name} item={item} {...shared(props)} className={styles.sizeRow}>
            <span className={styles.sizeSample} style={{ fontFamily: large ? system.display : system.body, fontSize: item.px === null ? `min(${item.value}, 64px)` : Math.min(item.px, 64), letterSpacing: large ? system.tracking ?? undefined : undefined, fontWeight: large ? 600 : 400 }}>{sample}</span>
            <span className={styles.sizeValue}>{item.value}</span>
            <span className={styles.sizeName}>{slug(item.name)}</span>
          </Tile>;
        })}
      </div>
    </Block>}
    {leadings.length > 0 && <Block title={chinese ? '行高' : 'Leading'}>
      <div className={styles.columns}>
        {leadings.map((item) => {
          const ratio = Number(item.value);
          return <Tile key={item.name} item={item} {...shared(props)} className={styles.textTile}>
            <span className={styles.leadingSample} style={{ fontFamily: system.body, lineHeight: item.value || undefined }}>{paragraph}</span>
            <Caption item={item} value={Number.isFinite(ratio) ? `${item.value} · ${Math.round(ratio * 15)}/15px` : undefined} />
          </Tile>;
        })}
      </div>
    </Block>}
    {(trackings.length > 0 || weights.length > 0) && <Block title={chinese ? '字距与字重' : 'Tracking and weight'}>
      <div className={styles.columns}>
        {trackings.map((item) => <Tile key={item.name} item={item} {...shared(props)} className={styles.textTile}>
          <span className={styles.trackingSample} style={{ fontFamily: system.display, letterSpacing: item.value || undefined }}>Hamburgefonts 永</span>
          <Caption item={item} />
        </Tile>)}
        {weights.map((item) => <Tile key={item.name} item={item} {...shared(props)} className={styles.textTile}>
          <span className={styles.trackingSample} style={{ fontFamily: system.display, fontWeight: item.value as CSSProperties['fontWeight'] }}>Hamburgefonts 永</span>
          <Caption item={item} />
        </Tile>)}
      </div>
    </Block>}
  </>;
}

function Spacing(props: SpecimenProps) {
  const { items, selected } = props;
  const steps = [...items].sort((a, b) => (a.px ?? 0) - (b.px ?? 0));
  // Named and numbered aliases of one size would only repeat a gap in the composition.
  const gaps = steps.filter((item, index) => index === 0 || item.value !== steps[index - 1]!.value);
  const active = items.find((item) => item.name === selected)?.value;
  return <div className={styles.spacing}>
    <div className={styles.panelPlain}>
      {steps.map((item) => <Tile key={item.name} item={item} {...shared(props)} className={styles.spaceRow}>
        <span className={styles.spaceName}>{slug(item.name)}</span>
        <span className={styles.spaceTrack}><span className={styles.spaceBar} style={{ width: item.value || 0 }} /><span className={styles.spaceValue}>{item.value}</span></span>
      </Tile>)}
    </div>
    <div className={styles.rhythm} aria-hidden="true">
      <span className={styles.rhythmBlock} />
      {gaps.map((item) => <span key={item.name} className={styles.rhythmStep}>
        <span className={styles.rhythmGap} data-active={active === item.value || undefined} style={{ height: item.value || 0 }}>
          <span className={styles.rhythmLabel}>{item.px ?? item.value}</span>
        </span>
        <span className={styles.rhythmBlock} />
      </span>)}
    </div>
  </div>;
}

function Radius(props: SpecimenProps) {
  return <div className={styles.radii}>
    {props.items.map((item) => {
      const pill = (item.px ?? 0) >= 100 || /^(?:[5-9]\d|100)%$/.test(item.value);
      return <Tile key={item.name} item={item} {...shared(props)} className={styles.radiusTile}>
        <span className={styles.radiusStage}>
          {pill ? <span className={styles.radiusPill} style={{ borderRadius: item.value }} /> : <span className={styles.radiusQuarter} style={{ borderTopLeftRadius: item.value || undefined }} />}
        </span>
        <Caption item={item} />
      </Tile>;
    })}
  </div>;
}

function Shadows(props: SpecimenProps) {
  return <div className={styles.shadows}>
    {props.items.map((item) => <Tile key={item.name} item={item} {...shared(props)} className={styles.shadowTile} title={item.value}>
      <span className={styles.shadowStage}><span className={styles.shadowCard} style={{ boxShadow: item.value || undefined }} /></span>
      <Caption item={item} value={slug(item.name)} />
    </Tile>)}
  </div>;
}

/** Plays on demand and rewinds on leave: nothing moves at rest. */
function usePlayer(build: () => Animation[]) {
  const running = useRef<Animation[]>([]);
  const stop = () => { for (const animation of running.current) animation.cancel(); running.current = []; };
  useEffect(() => stop, []);
  return {
    play() { stop(); if (motionAllowed()) running.current = build(); },
    rewind() { for (const animation of running.current) animation.reverse(); },
  };
}
const animate = (node: Element | null, frames: Keyframe[], options: KeyframeAnimationOptions) => node?.animate ? [node.animate(frames, { fill: 'both', ...options })] : [];

function Motion(props: SpecimenProps) {
  const { items, chinese } = props;
  const durations = items.filter((item) => durationOf(item.value) !== null);
  const curves = items.filter((item) => durationOf(item.value) === null && bezierOf(item.value));
  const rest = items.filter((item) => !durations.includes(item) && !curves.includes(item));
  const order = [...durations].sort((a, b) => (durationOf(a.value) ?? 0) - (durationOf(b.value) ?? 0));
  return <>
    <Block title={chinese ? '时长与缓动' : 'Durations and easing'} hint={chinese ? '悬停播放，点击重播' : 'Hover to play, click to replay'}>
      <div className={styles.motion}>
        {order.length > 0 && <div className={styles.durations}>{order.map((item) => <DurationTile key={item.name} item={item} {...shared(props)} />)}</div>}
        {curves.map((item) => <CurveTile key={item.name} item={item} {...shared(props)} />)}
      </div>
    </Block>
    {rest.length > 0 && <Compact {...props} items={rest} />}
  </>;
}

function DurationTile({ item, ...selection }: { item: Item } & Pick<SpecimenProps, 'selected' | 'toggle'>) {
  const dot = useRef<HTMLSpanElement>(null);
  const track = useRef<HTMLSpanElement>(null);
  const duration = durationOf(item.value) ?? 200;
  const player = usePlayer(() => {
    const distance = (track.current?.clientWidth ?? 0) - (dot.current?.offsetWidth ?? 0);
    return animate(dot.current, [{ transform: 'translateX(0)' }, { transform: `translateX(${distance}px)` }], { duration, easing: 'ease-out' });
  });
  return <Tile item={item} {...selection} className={styles.durationTile} onPointerEnter={player.play} onPointerLeave={player.rewind} onClick={player.play}>
    <Caption item={item} />
    <span className={styles.durationTrack} ref={track}><span className={styles.durationDot} ref={dot} /></span>
  </Tile>;
}

function CurveTile({ item, ...selection }: { item: Item } & Pick<SpecimenProps, 'selected' | 'toggle'>) {
  const across = useRef<SVGGElement>(null);
  const up = useRef<SVGGElement>(null);
  const [x1, y1, x2, y2] = bezierOf(item.value) ?? [0, 0, 1, 1];
  const point = (x: number, y: number) => `${x * 100} ${100 - y * 100}`;
  const easing = item.value.trim();
  // Time runs linearly along x, the eased progress along y, so the dot traces the printed curve.
  const player = usePlayer(() => [
    ...animate(across.current, [{ transform: 'translateX(0px)' }, { transform: 'translateX(100px)' }], { duration: 900, easing: 'linear' }),
    ...animate(up.current, [{ transform: 'translateY(0px)' }, { transform: 'translateY(-100px)' }], { duration: 900, easing }),
  ]);
  return <Tile item={item} {...selection} className={styles.curveTile} title={item.value} onPointerEnter={player.play} onPointerLeave={player.rewind} onClick={player.play}>
    <svg className={styles.curve} viewBox="-8 -24 116 148" aria-hidden="true">
      <path className={styles.curveFrame} d="M0 0H100V100H0Z" />
      <path className={styles.curveHandle} d={`M0 100L${point(x1, y1)}M100 0L${point(x2, y2)}`} />
      <circle className={styles.curvePoint} cx={x1 * 100} cy={100 - y1 * 100} r="2.5" />
      <circle className={styles.curvePoint} cx={x2 * 100} cy={100 - y2 * 100} r="2.5" />
      <path className={styles.curveLine} d={`M0 100C${point(x1, y1)} ${point(x2, y2)} 100 0`} />
      <g ref={across}><g ref={up}><circle className={styles.curveDot} cx="0" cy="100" r="4.5" /></g></g>
    </svg>
    <Caption item={item} value={slug(item.name)} />
  </Tile>;
}

type LayoutKind = 'container' | 'gutter' | 'section' | 'breakpoint' | 'rest';
function layoutKind(name: string): LayoutKind {
  if (/breakpoint|screen/.test(name)) return 'breakpoint';
  if (/gutter|gap/.test(name)) return 'gutter';
  if (isSection(name)) return 'section';
  if (/container|max|width/.test(name)) return 'container';
  return 'rest';
}
/** A page wide enough to read every container against, when the system names only one width. */
const REFERENCE_SCREEN = 1920;

function Layout(props: SpecimenProps) {
  const { items, chinese } = props;
  const of = (kind: LayoutKind) => items.filter((item) => layoutKind(item.name) === kind);
  const widths = of('container').sort((a, b) => (b.px ?? 0) - (a.px ?? 0));
  const span = Math.max(REFERENCE_SCREEN, ...widths.map((item) => item.px ?? 0));
  const gutters = of('gutter'), sections = of('section');
  const isGrid = (item: Item) => /column/.test(item.name) && /^\d+$/.test(item.value) && Number(item.value) <= 24;
  const grids = of('rest').filter(isGrid), rest = of('rest').filter((item) => !isGrid(item));
  const breakpoints = of('breakpoint').sort((a, b) => (a.px ?? 0) - (b.px ?? 0));
  const reach = Math.max(1, ...breakpoints.map((item) => item.px ?? 0));
  return <>
    {widths.length > 0 && <Block title={chinese ? '内容宽度' : 'Container widths'} hint={chinese ? `按 ${span}px 屏幕缩放` : `Scaled to a ${span}px screen`}>
      <div className={styles.containers}>
        <span className={styles.screen}><span>{span}px</span></span>
        {widths.map((item) => <Tile key={item.name} item={item} {...shared(props)} className={styles.containerBar} style={{ width: item.px ? `${(item.px / span) * 100}%` : '100%' }}>
          <span className={styles.containerLabel}>{item.label}</span><span className={styles.mono}>{item.value}</span>
        </Tile>)}
      </div>
    </Block>}
    {gutters.length + grids.length > 0 && <Block title={chinese ? '边距与栅格' : 'Gutters and grid'}>
      <div className={styles.gaps}>
        {gutters.map((item) => <Tile key={item.name} item={item} {...shared(props)} className={styles.gapTile}>
          <span className={styles.gutterStage}><span className={styles.gapBlock} /><Dimension axis="x" value={item.value} /><span className={styles.gapBlock} /></span>
          <Caption item={item} />
        </Tile>)}
        {grids.map((item) => <Tile key={item.name} item={item} {...shared(props)} className={styles.gapTile}>
          <span className={styles.gridStage}>{Array.from({ length: Number(item.value) }, (_, index) => <span key={index} className={styles.gapBlock} />)}</span>
          <Caption item={item} />
        </Tile>)}
      </div>
    </Block>}
    {sections.length > 0 && <Block title={chinese ? '分区间距' : 'Section spacing'}>
      <div className={styles.gaps}>{sections.map((item) => <Tile key={item.name} item={item} {...shared(props)} className={styles.gapTile}>
        <span className={styles.sectionStage}><span className={styles.gapBlock} /><Dimension axis="y" value={item.value} /><span className={styles.gapBlock} /></span>
        <Caption item={item} />
      </Tile>)}</div>
    </Block>}
    {breakpoints.length > 0 && <Block title={chinese ? '断点' : 'Breakpoints'}>
      <div className={styles.ruler}>
        <span className={styles.rulerScale} aria-hidden="true"><span>0</span><span>{reach}px</span></span>
        {breakpoints.map((item) => <Tile key={item.name} item={item} {...shared(props)} className={styles.rulerRow}>
          <span className={styles.rulerName} title={item.name}>{slug(item.name).replace(/^(?:breakpoint|screen)-?/, '') || slug(item.name)}</span>
          <span className={styles.rulerTrack}><span className={styles.rulerBar} style={{ width: item.px ? `${(item.px / reach) * 100}%` : '100%' }} /></span>
          <span className={styles.rulerValue}>{item.value}</span>
        </Tile>)}
      </div>
    </Block>}
    {rest.length > 0 && <Compact {...props} items={rest} />}
  </>;
}
function Dimension({ axis, value }: { axis: 'x' | 'y'; value: string }) {
  return <span className={styles.dimension} data-axis={axis} style={axis === 'x' ? { width: value } : { height: value }}><span className={styles.dimensionLine} /></span>;
}

function Measure(props: SpecimenProps) {
  return <div className={styles.measures}>{props.items.map((item) => <MeasureTile key={item.name} item={item} body={props.system.body} chinese={props.chinese} selected={props.selected} toggle={props.toggle} />)}</div>;
}
function useFit(frame: RefObject<HTMLElement>, sheet: RefObject<HTMLElement>, value: string) {
  const [zoom, setZoom] = useState(1);
  const current = useRef(1);
  useEffect(() => {
    const box = frame.current, page = sheet.current;
    if (!box || !page || typeof ResizeObserver === 'undefined') return;
    const fit = () => {
      const natural = page.getBoundingClientRect().width / current.current;
      if (!natural) return;
      const next = Math.min(1, box.clientWidth / natural);
      current.current = next;
      setZoom(next);
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(box);
    return () => observer.disconnect();
  }, [frame, sheet, value]);
  return zoom;
}
function MeasureTile({ item, body, chinese, ...selection }: { item: Item; body: string; chinese: boolean } & Pick<SpecimenProps, 'selected' | 'toggle'>) {
  const frame = useRef<HTMLSpanElement>(null);
  const sheet = useRef<HTMLSpanElement>(null);
  const zoom = useFit(frame, sheet, item.value);
  return <Tile item={item} {...selection} className={styles.measureTile}>
    <span className={styles.measureFrame} ref={frame}>
      <span className={styles.measureSheet} ref={sheet} style={{ width: item.value || undefined, zoom, fontFamily: body }}>
        <span className={styles.measureRule} />
        <span>一行的长度决定阅读是否吃力。太长，眼睛找不到下一行；太短，节奏被不断打断。把正文收在这个宽度以内，长文读起来才轻松。</span>
        <span>The length of a line decides how hard reading feels. Too long and the eye loses the next line; too short and the rhythm keeps breaking.</span>
      </span>
    </span>
    <Caption item={item} value={zoom < 1 ? `${item.value} · ${Math.round(zoom * 100)}%` : item.value} hint={lineHint(item.value, chinese)} />
  </Tile>;
}
/** Characters a line holds: a ch is the width of '0', close to an average Latin letter; an ic, and an em, one CJK glyph. */
function lineHint(value: string, chinese: boolean): string | undefined {
  const match = /^(\d*\.?\d+)(ch|ic|em)$/.exec(value.trim());
  if (!match) return undefined;
  const count = Math.round(Number(match[1]));
  if (match[2] === 'ch') return chinese ? `约 ${count} 个西文字符` : `≈ ${count} Latin characters`;
  return chinese ? `约 ${count} 个汉字` : `≈ ${count} CJK characters`;
}

/** The largest size the scale draws; a bigger token is drawn at this size and its caption says how far it was scaled. */
const SIZE_CAP = 96;
/** Ratio frames share one height, so their widths compare directly. */
const RATIO_HEIGHT = 64;
type SizeKind = 'icon' | 'target' | 'control' | 'square';
function sizeKind(name: string): SizeKind {
  if (/^--icon-/.test(name)) return 'icon';
  if (/^--(?:target|touch|tap)-/.test(name)) return 'target';
  if (/^--(?:control|button|input)-/.test(name)) return 'control';
  return 'square';
}
const isRatio = (name: string) => /aspect|(^--|-)ratio(-|$)/.test(name);
/** Width and height from '16 / 9', '16/9', '1.618/1' or '1'; null for anything else, such as 'auto'. */
function ratioOf(value: string): [number, number] | null {
  const match = /^(\d*\.?\d+)\s*(?:\/\s*(\d*\.?\d+))?$/.exec(value.trim());
  if (!match) return null;
  const [width, height] = [Number(match[1]), Number(match[2] ?? 1)];
  return width > 0 && height > 0 ? [width, height] : null;
}

function Sizing(props: SpecimenProps) {
  const { items, chinese } = props;
  const proportion = (item: Item) => { const ratio = ratioOf(item.value); return ratio ? ratio[0] / ratio[1] : 0; };
  const ratios = items.filter((item) => isRatio(item.name) && ratioOf(item.value)).sort((a, b) => proportion(a) - proportion(b));
  const steps = items.filter((item) => !isRatio(item.name) && item.px !== null && item.px >= 0).sort((a, b) => a.px! - b.px!);
  const rest = items.filter((item) => !ratios.includes(item) && !steps.includes(item));
  const largest = Math.max(0, ...steps.map((item) => item.px!));
  const hint = largest > SIZE_CAP
    ? (chinese ? `按实际大小绘制，超过 ${SIZE_CAP}px 的缩小显示` : `Actual size; anything over ${SIZE_CAP}px is scaled down`)
    : (chinese ? '按实际大小绘制' : 'Drawn at actual size');
  return <>
    {steps.length > 0 && <Block title={chinese ? '尺寸档位' : 'Size scale'} hint={hint}>
      <div className={styles.sizes} style={{ '--reach': `${Math.min(largest, SIZE_CAP)}px` } as CSSProperties}>
        {steps.map((item) => <SizeTile key={item.name} item={item} {...shared(props)} />)}
      </div>
    </Block>}
    {ratios.length > 0 && <Block title={chinese ? '宽高比' : 'Aspect ratios'}>
      <div className={styles.ratios}>{ratios.map((item) => {
        const [width, height] = ratioOf(item.value)!;
        return <Tile key={item.name} item={item} {...shared(props)}>
          <span className={styles.ratioStage}>
            <span className={styles.ratioFrame} data-kind="ratio" style={{ aspectRatio: `${width} / ${height}`, width: Math.round((RATIO_HEIGHT * width / height) * 100) / 100 }}>
              <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true"><path className={styles.ratioDiagonal} d="M0 100L100 0" /></svg>
            </span>
          </span>
          <Caption item={item} />
        </Tile>;
      })}</div>
    </Block>}
    {rest.length > 0 && <Compact {...props} items={rest} />}
  </>;
}
function SizeTile({ item, ...selection }: { item: Item } & Pick<SpecimenProps, 'selected' | 'toggle'>) {
  const px = item.px ?? 0;
  const drawn = Math.min(px, SIZE_CAP);
  const kind = sizeKind(item.name);
  const box: CSSProperties = { width: drawn, height: drawn };
  return <Tile item={item} {...selection}>
    <span className={styles.sizeStage}>
      {kind === 'icon' && <span className={styles.sizeIcon} data-kind={kind} style={box}><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.25" /><path d="M15 15l5 5" /></svg></span>}
      {kind === 'target' && <span className={styles.sizeTarget} data-kind={kind} style={box}><span className={styles.sizeTargetDot} /></span>}
      {kind === 'control' && <span className={styles.sizeControl} data-kind={kind} style={{ width: Math.max(drawn * 2.5, 48), height: drawn }}><span className={styles.sizeControlLabel} /></span>}
      {kind === 'square' && <span className={styles.sizeSquare} data-kind={kind} style={box} />}
    </span>
    <Caption item={item} value={px > SIZE_CAP ? `${item.value} · ${Math.round((SIZE_CAP / px) * 100)}%` : undefined} />
  </Tile>;
}

function Layers(props: SpecimenProps) {
  const planes = [...props.items].sort((a, b) => (Number(a.value) || 0) - (Number(b.value) || 0));
  return <div className={styles.planes} style={{ '--count': planes.length } as CSSProperties}>
    {planes.map((item, index) => <Tile key={item.name} item={item} {...shared(props)} className={styles.plane} style={{ '--index': index, zIndex: index + 1 } as CSSProperties}>
      <span className={styles.planeHead}><span>{item.label}</span><span className={styles.planeValue}>{item.value}</span></span>
    </Tile>)}
  </div>;
}

function Compact(props: SpecimenProps) {
  return <div className={styles.compact}>{props.items.map((item) => <Tile key={item.name} item={item} {...shared(props)} className={styles.compactTile} title={item.value}>
    <span className={styles.compactName}>{item.label}</span>
    <span className={styles.compactValue}>{item.value || '—'}</span>
  </Tile>)}</div>;
}

/** A small drawing of one token, for the dock header. */
export function StudioTokenMini({ name, group, value, ink, ground }: { name: string; group: StudioTokenGroup; value: string; ink: string; ground: string }) {
  const stage = { background: ground, color: ink } as CSSProperties;
  if (group === 'colors') return <span className={styles.mini} style={{ background: value || 'transparent' }} />;
  if (group === 'typography') {
    const kind = typeKind(name);
    const style: CSSProperties = kind === 'family' ? { fontFamily: value } : kind === 'size' ? { fontSize: `min(${value}, 26px)` } : kind === 'tracking' ? { letterSpacing: value } : kind === 'weight' ? { fontWeight: value as CSSProperties['fontWeight'] } : {};
    if (kind === 'leading') return <span className={styles.mini} style={stage}><span className={styles.miniLines} style={{ lineHeight: value }}>永<br />永</span></span>;
    return <span className={styles.mini} style={stage}><span className={styles.miniGlyph} style={style}>Aa</span></span>;
  }
  if (group === 'radius') return <span className={styles.mini} style={stage}><span className={styles.miniCorner} style={{ borderTopLeftRadius: value }} /></span>;
  if (group === 'shadows' || isRing(name)) return <span className={styles.mini} style={stage}><span className={styles.miniCard} style={{ boxShadow: value, background: ground }} /></span>;
  if (group === 'spacing') return <span className={styles.mini} style={stage}><span className={styles.miniBar} style={{ width: `min(${value}, 32px)` }} /></span>;
  if (group === 'motion') return <span className={styles.mini} style={stage}><span className={styles.miniDot} /></span>;
  if (group === 'sizing' && isRatio(name)) {
    const [width, height] = ratioOf(value) ?? [0, 0];
    const aspectRatio = `${width} / ${height}`;
    // The longer side fills the mini; aspect-ratio draws the other.
    if (width) return <span className={styles.mini} style={stage}><span className={styles.miniRatio} style={width >= height ? { aspectRatio, width: 28 } : { aspectRatio, height: 28 }} /></span>;
  } else if (group === 'sizing' && value) {
    return <span className={styles.mini} style={stage}><span className={styles.miniSquare} style={{ width: `min(${value}, 28px)`, height: `min(${value}, 28px)` }} /></span>;
  }
  return <span className={styles.mini} style={stage}><span className={styles.miniFrame} /></span>;
}
