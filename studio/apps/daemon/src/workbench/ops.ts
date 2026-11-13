// SPDX-License-Identifier: AGPL-3.0-only
// Derived from dsh-media-desk (https://github.com/woniuniuniu/dsh-media-desk), MIT, Copyright (c) 2026 woniuniuniu
// 工作台的唯一写入口：对话、界面操作、命令行都走这里，统一校验字段并产出回执。
// 模型输出也是不可信输入，所以这里只放行白名单字段。
import {
  WORKBENCH_KINDS, WORKBENCH_PLATFORMS, WORKBENCH_SPACE_COLORS, WORKBENCH_STATUSES,
  type WorkbenchItem, type WorkbenchKind, type WorkbenchOpName, type WorkbenchPlatform, type WorkbenchReceipt,
  type WorkbenchSpaceColor, type WorkbenchState, type WorkbenchStatus, type WorkbenchSkill, type WorkbenchStyle,
} from '@open-design/contracts';
import { currentLang, platformName, tr } from './i18n.js';
import { draftFormat } from './style.js';

export const STATUSES: readonly WorkbenchStatus[] = WORKBENCH_STATUSES;
export const STATUS_LABEL: Record<WorkbenchStatus, string> = { idea: '灵感', outline: '大纲', draft: '草稿', ready: '待发布', published: '已发布' };
export const KINDS: readonly WorkbenchKind[] = WORKBENCH_KINDS;
export const PLATFORMS: readonly WorkbenchPlatform[] = WORKBENCH_PLATFORMS;
export const SPACE_COLORS: readonly WorkbenchSpaceColor[] = WORKBENCH_SPACE_COLORS;

/** 状态在当前语言下的名字。 */
export function statusLabel(status: string): string {
  return tr(STATUS_LABEL[status as WorkbenchStatus] ?? String(status));
}

type FieldType = 'text' | 'summary' | 'id' | 'kind' | 'status' | 'platform' | 'list' | 'tags' | 'bool' | 'num' | 'minutes' | 'url' | 'date' | 'pos' | 'media';
type Input = Record<string, unknown>;

const ITEM_FIELDS: Record<string, FieldType> = {
  title: 'text', body: 'text', kind: 'kind', url: 'url', source: 'text', tags: 'tags', status: 'status', angleId: 'id',
  personaIds: 'list', parentId: 'id', rel: 'text', scheduledAt: 'date', platform: 'platform', pinned: 'bool', media: 'media', pos: 'pos', score: 'num',
  summary: 'summary', keywords: 'tags', ocrText: 'text', readMinutes: 'minutes', spaceId: 'id', starred: 'bool',
};
const PERSON_FIELDS: Record<string, FieldType> = { name: 'text', role: 'text', note: 'text', traits: 'list', tone: 'num' };
const ANGLE_FIELDS: Record<string, FieldType> = { name: 'text', hook: 'text', prompt: 'text' };
const STYLE_FIELDS: Record<string, FieldType> = { name: 'text', icon: 'text', summary: 'text', tone: 'text', sentences: 'text', opening: 'text', structure: 'text', logic: 'text', story: 'text', flow: 'text', words: 'list', avoid: 'list', samples: 'list' };
const SKILL_FIELDS: Record<string, FieldType> = { name: 'text', rule: 'text', source: 'text', status: 'text', confidence: 'num', evidence: 'text' };
const METRIC_FIELDS: Record<string, FieldType> = { itemId: 'id', platform: 'platform', date: 'date', views: 'num', likes: 'num', comments: 'num', shares: 'num', saves: 'num' };
const ACCOUNT_FIELDS: Record<string, FieldType> = { platform: 'text', handle: 'text', url: 'url', followers: 'num', note: 'text', title: 'text', description: 'text', avatar: 'url', fetchedAt: 'date', fetchError: 'text' };

let counter = 0;
export function newId(prefix = 'x'): string {
  counter += 1;
  return `${prefix}_${Date.now().toString(36)}${counter.toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
}

export function isHttpUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    const { protocol } = new URL(value);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

/** 媒体只允许工作台自己的相对路径或 http(s) 地址。 */
export const LOCAL_MEDIA = /^workbench\/(assets|files)\/[\w.-]+$/;
export function isMediaSrc(value: unknown): value is string {
  return typeof value === 'string' && (LOCAL_MEDIA.test(value) || isHttpUrl(value));
}

/** 标签：去空白、去重、限长，最多 24 个。 */
export function cleanTags(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: string[] = [];
  for (const raw of value) {
    if (typeof raw !== 'string') continue;
    const tag = raw.trim().replace(/^#/, '').slice(0, 40);
    if (tag && !out.includes(tag)) out.push(tag);
    if (out.length >= 24) break;
  }
  return out;
}

function coerce(type: FieldType, value: unknown): unknown {
  switch (type) {
    case 'text': return typeof value === 'string' ? value.slice(0, 40000) : undefined;
    case 'summary': return typeof value === 'string' ? value.trim().slice(0, 280) : undefined;
    case 'id': return value === null || typeof value === 'string' ? value : undefined;
    case 'kind': return KINDS.includes(value as WorkbenchKind) ? value : undefined;
    case 'status': return STATUSES.includes(value as WorkbenchStatus) ? value : undefined;
    case 'platform': return value === null || PLATFORMS.includes(value as WorkbenchPlatform) ? value : undefined;
    case 'list': return Array.isArray(value) ? value.filter(v => typeof v === 'string').slice(0, 24) : undefined;
    case 'tags': return cleanTags(value);
    case 'bool': return typeof value === 'boolean' ? value : undefined;
    case 'num': return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
    case 'minutes': return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(10000, Math.round(value))) : undefined;
    case 'url': return value === null || value === '' ? null : isHttpUrl(value) ? value : undefined;
    case 'date': return value === null ? null : typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? new Date(value).toISOString() : undefined;
    case 'pos': {
      const pos = value as { x?: unknown; y?: unknown; r?: unknown } | null;
      return pos && typeof pos.x === 'number' && typeof pos.y === 'number' && Number.isFinite(pos.x) && Number.isFinite(pos.y)
        ? { x: pos.x, y: pos.y, r: typeof pos.r === 'number' && Number.isFinite(pos.r) ? pos.r : 0 } : undefined;
    }
    case 'media': {
      if (value === null) return null;
      const media = value as Input | undefined;
      if (!media || !isMediaSrc(media.src)) return undefined;
      const finite = (key: string) => (typeof media[key] === 'number' && Number.isFinite(media[key]) ? { [key]: media[key] } : {});
      const mime = typeof media.mime === 'string' && /^[\w.+-]+\/[\w.+-]+$/.test(media.mime) ? media.mime.slice(0, 100) : undefined;
      const colors = Array.isArray(media.colors) ? media.colors.filter((c): c is string => typeof c === 'string' && /^#[0-9a-f]{6}$/i.test(c)).slice(0, 8) : undefined;
      return {
        src: media.src,
        ...(isMediaSrc(media.poster) ? { poster: media.poster } : {}),
        ...finite('w'), ...finite('h'), ...finite('bytes'), ...finite('durationSec'),
        ...(mime ? { mime } : {}),
        ...(colors?.length ? { colors } : {}),
      };
    }
    default: return undefined;
  }
}

function pick(fields: Record<string, FieldType>, input: Input): Input {
  const out: Input = {};
  for (const [key, type] of Object.entries(fields)) {
    if (input?.[key] === undefined) continue;
    const value = coerce(type, input[key]);
    if (value !== undefined) out[key] = value;
  }
  return out;
}

function findById<T extends { id: string }>(list: T[], id: unknown): T {
  const entry = list.find(row => row.id === id);
  if (!entry) throw new Error(tr('找不到对象：{id}', { id: String(id) }));
  return entry;
}

function short(text: unknown, n = 22): string {
  const s = String(text || '').trim();
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

const MONTHS_EN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function fmtWhen(iso: string | null | undefined): string {
  if (!iso) return tr('未排期');
  const d = new Date(iso);
  const pad = (v: number) => String(v).padStart(2, '0');
  return `${fmtShort(iso)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function fmtShort(iso: string): string {
  const d = new Date(iso);
  return currentLang() === 'en' ? `${MONTHS_EN[d.getMonth()]} ${d.getDate()}` : `${d.getMonth() + 1}月${d.getDate()}日`;
}

/** 改状态时一并维护发布时间：进入已发布记下时间，离开已发布清掉。 */
function applyStatus(item: WorkbenchItem, status: WorkbenchStatus): void {
  item.status = status;
  if (status === 'published' && !item.publishedAt) item.publishedAt = new Date().toISOString();
  if (status !== 'published') delete item.publishedAt;
}

/** 排上日历就是待发布（还没成稿的算大纲）；取消排期退回去。已发布的不动。 */
function applySchedule(item: WorkbenchItem, when: string | null): void {
  item.scheduledAt = when;
  if (item.status === 'published') return;
  const produced = item.production?.status === 'done';
  if (when) item.status = produced || ['draft', 'ready'].includes(item.status) ? 'ready' : 'outline';
  else if (item.status === 'ready') item.status = 'draft';
  else if (item.status === 'outline' && !produced) item.status = 'idea';
}

/** 空间 id 必须存在；null 表示不放进任何空间。 */
function checkSpace(state: WorkbenchState, spaceId: unknown): void {
  if (spaceId === null || spaceId === undefined) return;
  if (!state.spaces.some(row => row.id === spaceId)) throw new Error(tr('找不到空间：{id}', { id: String(spaceId) }));
}

/** 批量操作的目标条目。找不到的 id 跳过，一个都找不到才报错。 */
function itemsOf(state: WorkbenchState, ids: unknown): WorkbenchItem[] {
  const list = Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string').slice(0, 2000) : typeof ids === 'string' ? [ids] : [];
  const wanted = new Set(list);
  const found = state.items.filter(row => wanted.has(row.id));
  if (!found.length) throw new Error(tr('找不到要处理的条目'));
  return found;
}

/** 一条时说标题，多条时说数量。 */
function countText(items: WorkbenchItem[], one: string, many: string, vars: Record<string, unknown> = {}): string {
  return items.length === 1 ? tr(one, { ...vars, title: short(items[0]!.title) }) : tr(many, { ...vars, n: items.length });
}

const MEDIA_TITLE: Partial<Record<WorkbenchKind, string>> = { video: '{date}的视频', pdf: '{date}的 PDF', audio: '{date}的录音' };

/** 永久删除一组条目：子条目挂到上一级，对应的数据一并删掉。 */
function removeItems(state: WorkbenchState, ids: Set<string>): number {
  const parentOf = new Map(state.items.map(row => [row.id, row.parentId ?? null]));
  const before = state.items.length;
  state.items = state.items.filter(row => !ids.has(row.id));
  for (const child of state.items) {
    let parent = child.parentId ?? null;
    while (parent && ids.has(parent)) parent = parentOf.get(parent) ?? null;
    if (parent !== (child.parentId ?? null)) child.parentId = parent;
  }
  state.metrics = state.metrics.filter(row => !row.itemId || !ids.has(row.itemId));
  return before - state.items.length;
}

type Handler = (state: WorkbenchState, op: Input, now: string) => WorkbenchReceipt | null;

const handlers: Record<WorkbenchOpName, Handler> = {
  add_item(state, op, now) {
    const fields = pick(ITEM_FIELDS, op);
    checkSpace(state, fields.spaceId);
    const item = { id: newId('it'), kind: 'note', title: '', body: '', tags: [], status: 'idea', personaIds: [], createdAt: now, drafts: {}, ...fields } as WorkbenchItem;
    if (!item.title && !item.body && !item.media) throw new Error(tr('灵感内容为空'));
    // 只贴了图、视频或文件也要有个名字，卡片和回执才有东西可显示
    if (!item.title) item.title = short(item.body, 28) || (item.media ? tr(MEDIA_TITLE[item.kind] ?? '{date}的图片', { date: fmtShort(now) }) : '');
    // 新收进来的先放收件箱；收的时候就选了空间的，算已经整理过
    if (item.spaceId) item.triagedAt = now;
    // 新灵感落在首屏文字旁边，一眼就能看到，也不会打乱已有布局
    if (!item.pos && !item.parentId) {
      const n = state.items.filter(row => !row.parentId && row.pos).length;
      const scale = 1 + (n % 6) * 0.2;
      item.pos = { x: Math.round(Math.cos(n * 2.39996) * 580 * scale), y: Math.round(Math.sin(n * 2.39996) * 340 * scale), r: ((n % 5) - 2) * 1.2 };
    }
    if (item.scheduledAt) applySchedule(item, item.scheduledAt);
    if (item.status === 'published') applyStatus(item, 'published');
    state.items.unshift(item);
    return { text: tr('记下灵感《{title}》', { title: short(item.title) }), target: item.id, kind: 'item' };
  },
  update_item(state, op, now) {
    const item = findById(state.items, op.id);
    const { status, scheduledAt, ...fields } = pick(ITEM_FIELDS, op);
    checkSpace(state, fields.spaceId);
    Object.assign(item, fields);
    if (fields.spaceId && !item.triagedAt) item.triagedAt = now;
    if (scheduledAt !== undefined) applySchedule(item, scheduledAt as string | null);
    if (status !== undefined) applyStatus(item, status as WorkbenchStatus);
    const names = [...Object.keys(fields), ...(status !== undefined ? ['status'] : []), ...(scheduledAt !== undefined ? ['scheduledAt'] : [])].filter(key => key !== 'pos');
    if (!names.length) return null;
    item.updatedAt = now;
    return { text: tr('更新《{title}》', { title: short(item.title) }), target: item.id, kind: 'item' };
  },
  delete_item(state, op) {
    const item = findById(state.items, op.id);
    removeItems(state, new Set([item.id]));
    return { text: tr('删除《{title}》', { title: short(item.title) }) };
  },
  schedule_item(state, op, now) {
    const item = findById(state.items, op.id);
    const when = coerce('date', op.scheduledAt) as string | null | undefined;
    if (when === undefined) throw new Error(tr('排期时间无效'));
    const platform = coerce('platform', op.platform) as WorkbenchPlatform | null | undefined;
    if (platform !== undefined) item.platform = platform;
    applySchedule(item, when);
    item.updatedAt = now;
    return { text: when ? tr('把《{title}》排到 {when}', { title: short(item.title), when: fmtWhen(when) }) + (item.platform ? ` · ${platformName(item.platform)}` : '') : tr('取消《{title}》的排期', { title: short(item.title) }), target: item.id, kind: 'item' };
  },
  set_status(state, op, now) {
    const item = findById(state.items, op.id);
    const status = coerce('status', op.status) as WorkbenchStatus | undefined;
    if (!status) throw new Error(tr('状态无效'));
    applyStatus(item, status);
    item.updatedAt = now;
    return { text: tr('《{title}》状态改为「{status}」', { title: short(item.title), status: statusLabel(status) }), target: item.id, kind: 'item' };
  },
  save_draft(state, op, now) {
    const item = findById(state.items, op.id);
    const format = op.format === 'script' ? 'script' : 'article';
    if (typeof op.text !== 'string') throw new Error(tr('草稿内容无效'));
    const previous = item.drafts?.[format];
    const aiText = op.by === 'ai' ? op.text : previous?.aiText;
    item.drafts = { ...item.drafts, [format]: { text: op.text.slice(0, 200000), by: op.by === 'ai' ? 'ai' : 'user', ...(typeof op.engine === 'string' ? { engine: op.engine } : {}), at: now, ...(aiText !== undefined ? { aiText } : {}) } };
    if (['idea', 'outline'].includes(item.status)) item.status = 'draft';
    item.updatedAt = now;
    return { text: tr(format === 'script' ? '保存《{title}》的脚本' : '保存《{title}》的文章', { title: short(item.title) }), target: item.id, kind: 'item' };
  },
  update_production(state, op, now) {
    const item = findById(state.items, op.id);
    if (!item.production) throw new Error(tr('这条灵感还没有成稿'));
    if (typeof op.title === 'string') item.production.title = op.title.slice(0, 200);
    if (typeof op.coverText === 'string') item.production.coverText = op.coverText.slice(0, 40);
    if (typeof op.article === 'string') item.production.article = op.article.slice(0, 200000);
    item.updatedAt = now;
    return { text: tr('修改《{title}》', { title: short(item.production.title) }), target: item.id, kind: 'item' };
  },
  add_person(state, op, now) {
    const person = { id: newId('p'), name: '', role: tr('目标读者'), note: '', traits: [], tone: Math.floor(Math.random() * 6), createdAt: now, ...pick(PERSON_FIELDS, op) } as WorkbenchState['people'][number];
    if (!person.name) throw new Error(tr('人物需要名字'));
    state.people.push(person);
    return { text: tr('添加人物「{name}」', { name: person.name }), target: person.id, kind: 'person' };
  },
  update_person(state, op) {
    const person = findById(state.people, op.id);
    Object.assign(person, pick(PERSON_FIELDS, op));
    return { text: tr('更新人物「{name}」', { name: person.name }), target: person.id, kind: 'person' };
  },
  delete_person(state, op) {
    const person = findById(state.people, op.id);
    state.people = state.people.filter(row => row.id !== op.id);
    for (const item of state.items) item.personaIds = (item.personaIds || []).filter(id => id !== op.id);
    return { text: tr('删除人物「{name}」', { name: person.name }) };
  },
  add_angle(state, op, now) {
    const angle = { id: newId('a'), name: '', hook: '', prompt: '', createdAt: now, ...pick(ANGLE_FIELDS, op) } as WorkbenchState['angles'][number];
    if (!angle.name) throw new Error(tr('角度需要名字'));
    state.angles.push(angle);
    return { text: tr('添加创作角度「{name}」', { name: angle.name }), target: angle.id, kind: 'angle' };
  },
  update_angle(state, op) {
    const angle = findById(state.angles, op.id);
    Object.assign(angle, pick(ANGLE_FIELDS, op));
    return { text: tr('更新创作角度「{name}」', { name: angle.name }), target: angle.id, kind: 'angle' };
  },
  delete_angle(state, op) {
    const angle = findById(state.angles, op.id);
    state.angles = state.angles.filter(row => row.id !== op.id);
    for (const item of state.items) if (item.angleId === op.id) item.angleId = null;
    return { text: tr('删除创作角度「{name}」', { name: angle.name }) };
  },
  add_style(state, op, now) {
    const style = { id: newId('st'), source: tr('手动'), createdAt: now, summary: '', tone: '', sentences: '', opening: '', structure: '', logic: '', story: '', flow: '', words: [], avoid: [], samples: [], ...pick(STYLE_FIELDS, op) } as unknown as WorkbenchStyle;
    if (!style.name) throw new Error(tr('风格需要名字'));
    state.styles = [style, ...(state.styles ?? [])];
    return { text: tr('添加风格「{name}」', { name: style.name }), target: style.id, kind: 'style' };
  },
  update_style(state, op) {
    const style = findById(state.styles ?? [], op.id);
    Object.assign(style, pick(STYLE_FIELDS, op));
    return { text: tr('更新风格「{name}」', { name: style.name }) };
  },
  delete_style(state, op) {
    const style = findById(state.styles ?? [], op.id);
    state.styles = state.styles.filter(row => row.id !== op.id);
    if (state.activeStyleId === op.id) state.activeStyleId = null;
    return { text: tr('删除风格「{name}」', { name: style.name }) };
  },
  set_style(state, op) {
    if (op.id === null) {
      state.activeStyleId = null;
      return { text: tr('不再使用特定风格') };
    }
    const style = findById(state.styles ?? [], op.id);
    state.activeStyleId = style.id;
    return { text: tr('之后按「{name}」的风格写', { name: style.name }) };
  },
  set_format(state, op) {
    state.draftFormat = draftFormat(op.format);
    return { text: state.draftFormat === 'article' ? tr('之后写成文章') : tr('之后写成口播脚本') };
  },
  add_skill(state, op, now) {
    const skill = { id: newId('s'), name: '', rule: '', source: tr('对话'), status: 'proposed', confidence: 0.5, createdAt: now, ...pick(SKILL_FIELDS, op) } as WorkbenchSkill;
    if (!skill.name || !skill.rule) throw new Error(tr('Skill 需要名字和规则'));
    state.skills.unshift(skill);
    return { text: tr('沉淀规则「{name}」', { name: skill.name }), target: skill.id, kind: 'skill' };
  },
  update_skill(state, op) {
    const skill = findById(state.skills, op.id);
    Object.assign(skill, pick(SKILL_FIELDS, op));
    return { text: tr('更新规则「{name}」', { name: skill.name }), target: skill.id, kind: 'skill' };
  },
  delete_skill(state, op) {
    const skill = findById(state.skills, op.id);
    state.skills = state.skills.filter(row => row.id !== op.id);
    return { text: tr('删除规则「{name}」', { name: skill.name }) };
  },
  add_metric(state, op) {
    const metric = { id: newId('m'), date: new Date().toISOString(), views: 0, likes: 0, comments: 0, shares: 0, saves: 0, ...pick(METRIC_FIELDS, op) } as WorkbenchState['metrics'][number];
    if (!metric.platform) throw new Error(tr('数据需要平台'));
    state.metrics.push(metric);
    return { text: tr('记录 {platform} 数据 {views} 阅读', { platform: platformName(metric.platform), views: metric.views }) };
  },
  add_account(state, op, now) {
    const account = { id: newId('ac'), platform: '', handle: '', url: null, followers: null, createdAt: now, ...pick(ACCOUNT_FIELDS, op) } as WorkbenchState['accounts'][number];
    if (!account.platform && !account.handle && !account.url) throw new Error(tr('账号信息为空'));
    state.accounts.push(account);
    return { text: tr('添加账号档案「{name}」', { name: account.handle || account.title || platformName(account.platform) }), target: account.id, kind: 'account' };
  },
  update_account(state, op) {
    const account = findById(state.accounts, op.id);
    Object.assign(account, pick(ACCOUNT_FIELDS, op));
    return { text: tr('更新账号档案「{name}」', { name: account.handle || account.title || platformName(account.platform) }) };
  },
  delete_account(state, op) {
    findById(state.accounts, op.id);
    state.accounts = state.accounts.filter(row => row.id !== op.id);
    return { text: tr('删除账号档案') };
  },
  clear_samples(state) {
    state.items = state.items.filter(row => !row.sample);
    state.people = state.people.filter(row => !row.sample);
    state.angles = state.angles.filter(row => !row.sample);
    state.metrics = state.metrics.filter(row => !row.sample);
    state.accounts = state.accounts.filter(row => !row.sample);
    state.skills = state.skills.filter(row => !row.sample);
    state.spaces = state.spaces.filter(row => !row.sample);
    state.styles = (state.styles ?? []).filter(row => !row.sample);
    if (!state.styles.some(row => row.id === state.activeStyleId)) state.activeStyleId = null;
    // 自己的数据可能挂在示例内容下面：父条目没了就断开，指标没了对应内容就删掉，空间没了就移出
    const ids = new Set(state.items.map(row => row.id));
    const spaces = new Set(state.spaces.map(row => row.id));
    for (const row of state.items) {
      if (row.parentId && !ids.has(row.parentId)) row.parentId = null;
      if (row.spaceId && !spaces.has(row.spaceId)) row.spaceId = null;
    }
    state.metrics = state.metrics.filter(row => !row.itemId || ids.has(row.itemId));
    state.sampleCleared = true;
    return { text: tr('已清空全部示例数据') };
  },

  // ── 灵感库（Resurf）────────────────────────────────────────────
  star_items(state, op, now) {
    const items = itemsOf(state, op.ids);
    const starred = op.starred !== false;
    for (const item of items) { item.starred = starred; item.updatedAt = now; }
    return starred
      ? { text: countText(items, '星标《{title}》', '星标 {n} 条'), kind: 'item', ...(items.length === 1 ? { target: items[0]!.id } : {}) }
      : { text: countText(items, '取消《{title}》的星标', '取消 {n} 条的星标'), kind: 'item', ...(items.length === 1 ? { target: items[0]!.id } : {}) };
  },
  move_to_space(state, op, now) {
    const items = itemsOf(state, op.ids);
    const spaceId = typeof op.spaceId === 'string' ? op.spaceId : null;
    const space = spaceId ? findById(state.spaces, spaceId) : null;
    for (const item of items) {
      item.spaceId = space?.id ?? null;
      item.triagedAt ??= now;
      item.updatedAt = now;
    }
    return space
      ? { text: countText(items, '把《{title}》放进「{space}」', '把 {n} 条放进「{space}」', { space: space.name }), target: space.id, kind: 'space' }
      : { text: countText(items, '把《{title}》移出空间', '把 {n} 条移出空间'), kind: 'item' };
  },
  keep_items(state, op, now) {
    const items = itemsOf(state, op.ids);
    for (const item of items) { item.triagedAt ??= now; item.updatedAt = now; }
    return { text: countText(items, '《{title}》移出收件箱', '{n} 条移出收件箱'), kind: 'item' };
  },
  trash_items(state, op, now) {
    const items = itemsOf(state, op.ids);
    for (const item of items) { item.trashedAt = now; item.updatedAt = now; }
    return { text: countText(items, '把《{title}》移到废纸篓', '把 {n} 条移到废纸篓'), kind: 'item' };
  },
  restore_items(state, op, now) {
    const items = itemsOf(state, op.ids);
    for (const item of items) { delete item.trashedAt; item.updatedAt = now; }
    return { text: countText(items, '恢复《{title}》', '恢复 {n} 条'), kind: 'item', ...(items.length === 1 ? { target: items[0]!.id } : {}) };
  },
  empty_trash(state) {
    const ids = new Set(state.items.filter(row => row.trashedAt).map(row => row.id));
    if (!ids.size) return { text: tr('废纸篓是空的') };
    const n = removeItems(state, ids);
    return { text: tr('清空废纸篓，永久删除 {n} 条', { n }) };
  },
  add_space(state, op, now) {
    const name = typeof op.name === 'string' ? op.name.trim().slice(0, 40) : '';
    if (!name) throw new Error(tr('空间需要名字'));
    if (state.spaces.some(row => row.name === name)) throw new Error(tr('已经有叫「{name}」的空间', { name }));
    const color = SPACE_COLORS.includes(op.color as WorkbenchSpaceColor) ? op.color as WorkbenchSpaceColor : SPACE_COLORS[state.spaces.length % SPACE_COLORS.length]!;
    const space = { id: newId('sp'), name, color, createdAt: now };
    state.spaces.push(space);
    return { text: tr('新建空间「{name}」', { name }), target: space.id, kind: 'space' };
  },
  update_space(state, op) {
    const space = findById(state.spaces, op.id);
    if (typeof op.name === 'string') {
      const name = op.name.trim().slice(0, 40);
      if (!name) throw new Error(tr('空间需要名字'));
      if (state.spaces.some(row => row.id !== space.id && row.name === name)) throw new Error(tr('已经有叫「{name}」的空间', { name }));
      space.name = name;
    }
    if (SPACE_COLORS.includes(op.color as WorkbenchSpaceColor)) space.color = op.color as WorkbenchSpaceColor;
    return { text: tr('更新空间「{name}」', { name: space.name }), target: space.id, kind: 'space' };
  },
  delete_space(state, op, now) {
    const space = findById(state.spaces, op.id);
    state.spaces = state.spaces.filter(row => row.id !== space.id);
    // 空间里的条目留在库里，仍算整理过
    for (const item of state.items) {
      if (item.spaceId !== space.id) continue;
      item.spaceId = null;
      item.triagedAt ??= now;
    }
    return { text: tr('删除空间「{name}」', { name: space.name }) };
  },
  rename_tag(state, op, now) {
    const from = typeof op.from === 'string' ? op.from.trim().replace(/^#/, '') : '';
    const to = typeof op.to === 'string' ? op.to.trim().replace(/^#/, '').slice(0, 40) : '';
    if (!from || !to) throw new Error(tr('标签名无效'));
    let n = 0;
    for (const item of state.items) {
      if (!item.tags.includes(from)) continue;
      item.tags = cleanTags(item.tags.map(tag => (tag === from ? to : tag))) ?? [];
      item.updatedAt = now;
      n += 1;
    }
    if (!n) throw new Error(tr('没有带「{tag}」标签的条目', { tag: from }));
    return { text: tr('把标签「{from}」改成「{to}」（{n} 条）', { from, to, n }) };
  },
  delete_tag(state, op, now) {
    const tag = typeof op.tag === 'string' ? op.tag.trim().replace(/^#/, '') : '';
    if (!tag) throw new Error(tr('标签名无效'));
    let n = 0;
    for (const item of state.items) {
      if (!item.tags.includes(tag)) continue;
      item.tags = item.tags.filter(row => row !== tag);
      item.updatedAt = now;
      n += 1;
    }
    if (!n) throw new Error(tr('没有带「{tag}」标签的条目', { tag }));
    return { text: tr('删除标签「{tag}」（{n} 条）', { tag, n }) };
  },
  tag_items(state, op, now) {
    const items = itemsOf(state, op.ids);
    const add = cleanTags(op.add) ?? [];
    const remove = new Set(cleanTags(op.remove) ?? []);
    if (!add.length && !remove.size) throw new Error(tr('标签名无效'));
    for (const item of items) {
      item.tags = cleanTags([...item.tags.filter(tag => !remove.has(tag)), ...add]) ?? [];
      item.updatedAt = now;
    }
    return { text: countText(items, '更新《{title}》的标签', '更新 {n} 条的标签'), kind: 'item', ...(items.length === 1 ? { target: items[0]!.id } : {}) };
  },
  add_highlight(state, op, now) {
    const item = findById(state.items, op.id);
    const text = typeof op.text === 'string' ? op.text.trim().slice(0, 4000) : '';
    if (!text) throw new Error(tr('划线内容为空'));
    const note = typeof op.note === 'string' && op.note.trim() ? op.note.trim().slice(0, 2000) : undefined;
    item.highlights = [...(item.highlights ?? []), { id: newId('hl'), text, ...(note ? { note } : {}), at: now }].slice(-500);
    item.updatedAt = now;
    return { text: tr('在《{title}》里划线', { title: short(item.title) }), target: item.id, kind: 'item' };
  },
  delete_highlight(state, op, now) {
    const item = findById(state.items, op.id);
    const before = item.highlights?.length ?? 0;
    item.highlights = (item.highlights ?? []).filter(row => row.id !== op.highlightId);
    if (item.highlights.length === before) throw new Error(tr('找不到这条划线'));
    item.updatedAt = now;
    return { text: tr('删除《{title}》里的一条划线', { title: short(item.title) }), target: item.id, kind: 'item' };
  },
  mark_surfaced(state, op, now) {
    // 只记录「重新翻出来看过」，不算修改，不出回执
    for (const item of itemsOf(state, op.ids)) {
      item.lastSurfacedAt = now;
      item.surfacedCount = (item.surfacedCount ?? 0) + 1;
    }
    return null;
  },
};

/**
 * 依次执行一批操作。任何一条失败都不影响已成功的操作，失败写进 errors。
 * state 会被就地修改。
 */
export function applyOps(state: WorkbenchState, ops: unknown): { receipts: WorkbenchReceipt[]; errors: string[] } {
  const receipts: WorkbenchReceipt[] = [];
  const errors: string[] = [];
  const now = new Date().toISOString();
  for (const raw of Array.isArray(ops) ? ops : []) {
    const op = (raw && typeof raw === 'object' ? raw : {}) as Input;
    const name = op.op;
    const handler = typeof name === 'string' && Object.hasOwn(handlers, name) ? handlers[name as WorkbenchOpName] : undefined;
    if (!handler) {
      errors.push(tr('不支持的操作：{op}', { op: String(name) }));
      continue;
    }
    try {
      const receipt = handler(state, op, now);
      if (receipt) receipts.push(receipt);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  return { receipts, errors };
}

/** 没进废纸篓的条目。助手、成稿、排期、复盘和规则学习都只看这些。 */
export function liveItems(state: Pick<WorkbenchState, 'items'>): WorkbenchItem[] {
  return state.items.filter(row => !row.trashedAt);
}
