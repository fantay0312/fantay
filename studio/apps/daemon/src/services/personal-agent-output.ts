/** Evidence-aware excerpting. Full text remains immutable in the Attempt store. */
export function summarizePaOutput(text: string, maxChars = 1800): string {
  if (text.length <= maxChars) return text;
  let structured: Record<string, unknown> | null = null;
  try { const value: unknown = JSON.parse(text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')); if (value && typeof value === 'object' && !Array.isArray(value)) structured = value as Record<string, unknown>; } catch { /* ordinary text */ }
  if (structured) {
    const fields: string[] = [];
    for (const key of ['error', 'errors', 'issues', 'summary', 'verification', 'evidence', 'references']) if (structured[key] !== undefined) fields.push(`${key}: ${typeof structured[key] === 'string' ? structured[key] : JSON.stringify(structured[key])}`);
    if (Array.isArray(structured.files)) fields.push(`files: ${structured.files.map(value => { const file = value as { path?: unknown; content?: unknown }; return `${String(file.path ?? '?')} (${typeof file.content === 'string' ? file.content.length : '?'} chars)`; }).join(', ')}`);
    if (fields.length) return summarizePaOutput(fields.join('\n\n'), maxChars);
  }
  const blocks = text.split(/\n\s*\n|(?<=\n)(?=[#*-]\s)/u).map((content, index) => ({ content: content.trim(), index })).filter(block => block.content);
  const score = (content: string, index: number) => (/error|fail|exception|警告|失败|错误|未完成|待核对|限制|风险|缺失|拒绝|等待/i.test(content) ? 100 : 0) + (/验证|证据|结论|结果|来源|https?:\/\/|verification|evidence|references|summary/i.test(content) ? 30 : 0) + (/^#{1,6}\s/.test(content) ? 10 : 0) + (index === 0 ? 5 : 0);
  const chosen: Array<{ content: string; index: number }> = [];
  let remaining = Math.max(0, maxChars - 90);
  for (const block of [...blocks].sort((a, b) => score(b.content, b.index) - score(a.content, a.index) || a.index - b.index)) {
    if (remaining < 80) break;
    // Long blocks are reduced around the first relevant evidence line, not by
    // taking the head and tail of an arbitrarily large tool/model response.
    let content = block.content;
    if (content.length > remaining) {
      const relevant = /error|fail|exception|警告|失败|错误|未完成|待核对|限制|风险|缺失|拒绝|等待/i.exec(content)
        ?? /验证|证据|结论|结果|来源|https?:\/\/|verification|evidence|references|summary/i.exec(content);
      const from = relevant ? Math.max(0, relevant.index - 100) : 0;
      content = content.slice(from, from + Math.min(remaining, 700));
    }
    if (!chosen.some(item => item.content === content)) { chosen.push({ content, index: block.index }); remaining -= content.length + 2; }
  }
  return `关键内容摘录（原文 ${text.length.toLocaleString()} 字符；完整输出可在 PA 中分段读取或搜索）\n\n${chosen.sort((a, b) => a.index - b.index).map(block => block.content).join('\n\n')}`;
}
