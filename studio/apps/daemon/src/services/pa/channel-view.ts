import { checkShownView, showViewParameters, validateViewAnswer, viewSummary } from 'deep-view/core';
import type { PaViewAnswer, PaViewCard } from '@open-design/contracts';
import { PaError } from '../../storage/personal-agent-store.js';
import { parsePaJson } from '../personal-agent-artifacts.js';
import { redactPaCredentials } from '../personal-agent-gateway.js';

const blockedField = /password|passphrase|secret|api[ _-]?key|access[ _-]?token|private[ _-]?key|seed[ _-]?phrase|密码|密钥|令牌|助记词/iu;
function validComponent(node: Record<string, unknown>): boolean {
  if (node.type === 'html') return false;
  if (node.type === 'form' && Array.isArray(node.fields) && node.fields.some(field =>
    blockedField.test(`${field?.id ?? ''} ${field?.label ?? ''} ${field?.placeholder ?? ''}`))) return false;
  return !Array.isArray(node.children) || node.children.every(child => validComponent(child as Record<string, unknown>));
}

export const paViewPrompt =
  'When a chart, table, calculator, or form serves this reply, return only {"channelView":{"title":"short title","view":{...}}}. ' +
  'The view appears in Fantay; an interactive form waits for a once-only desktop answer. Use the answer in amendments before proceeding. ' +
  'Use declarative components only (no html). Never collect secrets. Mark sample numbers. ' +
  showViewParameters.view.description.replace(/html \(\{ html, summary, height\? \}:.*?\)\./, '').replace('sources ({ items: [{ label, url }] }), ', 'sources ({ items: [{ label, url }] }). ');

export function parsePaChannelView(text: string): PaViewCard | null {
  let raw: unknown;
  try { raw = parsePaJson(text).channelView; } catch { return null; }
  if (raw === undefined) return null;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
    throw new PaError('视图卡片格式无效，请重试', 422, 'PA_VIEW_INVALID');
  const { title, view } = raw as Record<string, unknown>;
  const checked = checkShownView(title, view);
  if ('error' in checked || !validComponent(checked.view))
    throw new PaError('视图卡片格式无效或包含不支持的控件，请重试', 422, 'PA_VIEW_INVALID');
  return {
    title: redactPaCredentials(checked.title).slice(0, 120), view: checked.view, interactive: checked.interactive,
    summary: redactPaCredentials(viewSummary(checked.view)).slice(0, 1200),
  };
}

export function validatePaViewAnswer(card: PaViewCard, action: string, values: Record<string, unknown>): PaViewAnswer {
  if (Buffer.byteLength(JSON.stringify(values)) > 8192) throw new PaError('表单内容过长', 422, 'PA_CARD_ANSWER');
  const checked = validateViewAnswer(card.view, action, values);
  if ('error' in checked) throw new PaError('请按视图卡片的字段和选项填写', 422, 'PA_CARD_ANSWER');
  return { action, values: JSON.parse(redactPaCredentials(JSON.stringify(checked))) as Record<string, unknown> };
}
