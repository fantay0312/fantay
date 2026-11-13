/** Read-only catalogue/control audit. Does not log in, invoke models or spend provider credit.
 * Usage: tsx apps/daemon/scripts/audit-tokentosea-reasoning.ts --catalog <json> --installed <json> --out <directory>
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { applyTokenToSeaReasoning, resolveTokenToSeaReasoning, tokenToSeaReasoningOptions } from '../src/integrations/tokentosea-reasoning.js';
import { isTokenToSeaAgentModel, type TokenToSeaModel } from '../src/integrations/tokentosea-runtime.js';
import { tokenToSeaNativePath } from '../src/integrations/tokentosea-claude.js';
import { expectedControls, reviewModel } from '../tests/fixtures/tokentosea-reasoning-review.js';

const args = process.argv.slice(2);
const argument = (key: string) => { const value = args[args.indexOf(key) + 1]; if (!args.includes(key) || !value || value.startsWith('--')) throw new Error(`Missing ${key}`); return value; };
const input = JSON.parse(readFileSync(argument('--catalog'), 'utf8')) as TokenToSeaModel[] | { models: TokenToSeaModel[] };
const models = Array.isArray(input) ? input : input.models;
const installed = JSON.parse(readFileSync(argument('--installed'), 'utf8')) as { agents: { models: Array<{ id: string; reasoningOptions?: Array<{ id: string; default?: boolean }> }> } };
const previous = new Map(installed.agents.models.map(model => [model.id, model]));
const out = path.resolve(argument('--out')); mkdirSync(out, { recursive: true });
const rows = models.map(model => {
  const review = reviewModel(model), options = tokenToSeaReasoningOptions(model), prior = previous.get(model.id);
  const cases = (options.length ? options.map(option => option.id) : [undefined]).map(requested => {
    const selected = resolveTokenToSeaReasoning(model, requested), wire: Record<string, unknown> = { max_tokens: model.maxOutputTokens ?? 4096 };
    applyTokenToSeaReasoning(model, selected, wire);
    const actual = Object.fromEntries(Object.entries(wire).filter(([key]) => ['thinking', 'thinking_budget', 'enable_thinking', 'reasoning_effort', 'reasoning', 'output_config'].includes(key)));
    const expected = expectedControls(review, selected, model.maxOutputTokens ?? 4096, ['qwen3.8-2.4t-a95b', 'qwen3.7-max-preview', 'qwen3.7-max-2026-05-17'].includes(String(model.upstreamModel ?? model.model)));
    return { requested: requested ?? null, selected, wire, mapping: review.options ? JSON.stringify(actual) === JSON.stringify(expected) ? 'matched' : 'mismatch' : 'unverified', live: 'not-run' };
  });
  const ids = options.map(option => option.id), selectedDefault = options.find(option => option.default)?.id ?? null;
  const knownMatch = review.options ? JSON.stringify(review.options) === JSON.stringify(ids) && review.default === selectedDefault && cases.every(value => value.mapping === 'matched') : null;
  const documented = model.modality === 'chat' && review.options !== null && !review.uncertainty;
  return { id: model.id, name: model.name ?? model.model, provider: model.provider, upstreamModel: model.upstreamModel ?? model.model, modality: model.modality, capturedSelectable: previous.has(model.id), currentlySelectable: isTokenToSeaAgentModel(model), path: model.modality === 'chat' ? tokenToSeaNativePath(model) : null, options, default: selectedDefault, reviewedOptions: review.options, nativeOptions: review.nativeOptions ?? review.options, reviewedDefault: review.default, localMapping: knownMatch === null ? 'unverified' : knownMatch ? 'matched' : 'mismatch', documented, uncertainty: review.uncertainty ?? null, note: review.note ?? null, sources: review.sourceUrls, changedSinceInstalled: prior ? JSON.stringify(prior.reasoningOptions?.map(value => [value.id, Boolean(value.default)])) !== JSON.stringify(options.map(value => [value.id, Boolean(value.default)])) : null, cases };
});
const chat = rows.filter(row => row.modality === 'chat');
const summary = {
  date: '2026-11-05', total: rows.length, chat: chat.length, capturedSelectable: rows.filter(row => row.capturedSelectable).length, currentlySelectable: rows.filter(row => row.currentlySelectable).length,
  nonChatExcluded: rows.filter(row => row.modality !== 'chat' && !row.currentlySelectable).length,
  documentedChatMappings: chat.filter(row => row.documented && row.localMapping === 'matched').length,
  uncertainChatMappings: chat.filter(row => !row.documented || row.localMapping === 'unverified').length,
  mappingMismatches: rows.filter(row => row.localMapping === 'mismatch').length,
  changedInstalledModels: rows.filter(row => row.changedSinceInstalled).length,
  selectableModelsWithControls: rows.filter(row => row.currentlySelectable && row.options.length).length,
  selectableModelsWithoutVerifiedControls: rows.filter(row => row.currentlySelectable && !row.options.length).length,
  selectableChoiceCases: rows.filter(row => row.currentlySelectable).reduce((sum, row) => sum + row.cases.length, 0),
  liveCasesRunThisAudit: 0, newProviderSpendUsd: 0, allLiveAccepted: false,
};
writeFileSync(path.join(out, 'audit.json'), JSON.stringify({ summary, limitations: ['Primary model docs do not verify a supplier alias, route or ignored parameter.', 'HTTP fixtures validate application wire projection only; they do not prove provider behavior.', 'Unknown is not unsupported. Historical snapshots, previews and retired models stay unverified.', 'Qwen/manual Claude budget presets are labelled token ceilings, not native effort grades; continuous budget ranges are not exhaustively enumerated.', 'OpenAI Chat tool+reasoning combinations need supplier conversion proof or a verified Responses route.', 'This read-only script performs no paid calls; live acceptance is reported separately.'], rows }, null, 2) + '\n');
const columns = ['id', 'name', 'provider', 'upstreamModel', 'modality', 'capturedSelectable', 'currentlySelectable', 'path', 'nativeOptions', 'reviewedDefault', 'default', 'localMapping', 'documented', 'uncertainty', 'note', 'sources'] as const;
const cell = (value: unknown) => `"${String(Array.isArray(value) ? value.join(' | ') : value ?? '').replaceAll('"', '""')}"`;
writeFileSync(path.join(out, 'audit.csv'), '\uFEFF' + columns.join(',') + '\n' + rows.map(row => columns.map(column => cell(row[column])).join(',')).join('\n') + '\n');
const lines = [
  '# TokenToSea 思考设置验收 · 2026-11-05', '',
  `覆盖全部 ${summary.total} 条目录记录，其中 ${summary.chat} 条为聊天模型；捕获安装版可选 ${summary.capturedSelectable} 条，当前源码筛选后可选 ${summary.currentlySelectable} 条。${summary.nonChatExcluded} 条非聊天记录均未进入 LLM 列表。`, '',
  `聊天模型中，${summary.documentedChatMappings} 条可按已核实的型号规则验证本地映射，${summary.uncertainChatMappings} 条仍存在型号、通道或文档不确定性。本地映射错误 ${summary.mappingMismatches} 条。相对安装版有 ${summary.changedInstalledModels} 条菜单或默认值变更。`, '',
  `当前可选模型共 ${summary.selectableChoiceCases} 组“通道 × 选项”本地请求链路用例；同时检查型号绑定、协议、默认值、旧设置清理、输出字段及预算标签。该数字不代表真实供应商调用通过数。`, '',
  '**本报告仅覆盖无费用的目录和本地映射核验。** 它不发起真实供应商调用；实际调用、结算和费用结果见单独的真实验收报告。官方参数说明和本地请求测试不能证明中转通道会执行参数，HTTP 200 也可能只是忽略了参数。', '',
  '已修正：Claude 各代思考模式/关闭选项、Sonnet 5.5 工具间模式、Haiku 预算标签；GPT 缺失档位；Gemini 3.8 的无效 minimal；Qwen 3.8 原生档位及旧系列预算预设；GLM/DeepSeek/Kimi 默认值；豆包重复别名；MiniMax M3、Step、Grok 与 MiMo 的控制映射。', '',
  'Claude 请求显式要求公开思考摘要并保留签名；不会承诺供应商返回原始思维链。Qwen/Haiku 的预设是 token 预算，菜单不再把它们放进“更快→更聪明”的强度滑杆。', '',
  '## 待核实的记录', '', '| 通道/型号 | 原因 |', '| --- | --- |',
  ...chat.filter(row => !row.documented).map(row => `| ${row.id} | ${row.uncertainty ?? '精确型号或快照的参数契约未核实'} |`), '',
  '## 文件', '', '- audit.csv：全目录逐型号明细。', '- audit.json：每个选项的实际请求字段、来源和验收状态。', '',
  '## 判定边界', '', '未发现公开控制契约的型号与明确没有原生档位的型号分开记录。供应商 Preview、日期别名及已退役 MiMo 2.5 不会因为参数能写入请求就被认定为通过。OpenAI 部分模型的工具调用需要 Responses；供应商当前仅验证 Chat 的路径，仍需独立真实验收。', '',
];
writeFileSync(path.join(out, '验收报告.md'), lines.join('\n'));
console.log(JSON.stringify(summary));
if (summary.mappingMismatches) process.exitCode = 1;
