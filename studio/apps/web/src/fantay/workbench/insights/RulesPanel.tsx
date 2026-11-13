/*
 * SPDX-License-Identifier: AGPL-3.0-only
 * Fantay 工作台 · 复盘 — 给你的建议 (rules learned from the data, each accepted into the writing
 * rules or dismissed) and 写作规则 (the active rules every production follows: edit, pause,
 * delete, add, and export them as a Fantay Skill).
 * Derived from dsh-media-desk client/insights.jsx and client/style.jsx
 * (https://github.com/woniuniuniu/dsh-media-desk), MIT, Copyright (c) 2026 woniuniuniu.
 */
import { useEffect, useId, useState } from 'react';
import { Copy, Download, Pencil, Plus, Sparkles, Trash2 } from 'lucide-react';
import type { WorkbenchSkill } from '@open-design/contracts';
import { Button, Callout, Field, Icon, IconButton, Input, Textarea, cn, toast } from '../../ui';
import { workbenchApi } from '../api';
import { useL } from '../lang';
import { reportError, workbench } from '../store';
import { useLastDefined } from '../pages-shared/data';
import { WbModal } from '../pages-shared/WbModal';
import page from '../pages-shared/page.module.css';
import styles from './InsightsPage.module.css';

export function SuggestionsTile({ skills, includeSamples, className }: { skills: WorkbenchSkill[]; includeSamples: boolean; className?: string }) {
  const L = useL();
  const [busy, setBusy] = useState(false);
  // once real data exists, sample rules stop being offered as suggestions
  const proposed = skills.filter((skill) => skill.status === 'proposed' && (includeSamples || !skill.sample));

  const learn = async () => {
    setBusy(true);
    try {
      const response = await workbenchApi.learnSkills();
      workbench.setState(response.state);
      toast({
        title: response.added
          ? L(`找到 ${response.added} 条新建议`, `${response.added} new suggestion${response.added === 1 ? '' : 's'}`)
          : L('暂时没有新发现，数据多一些再试', 'Nothing new yet — try again with more data'),
      });
    } catch (error) {
      reportError(error, L('分析失败', 'Analysis failed'));
    } finally {
      setBusy(false);
    }
  };

  const accept = (skill: WorkbenchSkill) =>
    void workbench.ops([{ op: 'update_skill', id: skill.id, status: 'active' }], { label: L(`启用规则「${skill.name}」`, `Enable rule “${skill.name}”`) });
  const dismiss = (skill: WorkbenchSkill) =>
    void workbench.ops([{ op: 'update_skill', id: skill.id, status: 'dismissed' }], { label: L(`忽略建议「${skill.name}」`, `Dismiss “${skill.name}”`) });

  return (
    <section className={cn(page.tile, page.rise, className)} aria-label={L('给你的建议', 'Suggestions')}>
      <header className={page.tileHead}>
        <h2 className={page.tileTitle}>{L('给你的建议', 'Suggestions')}</h2>
        {proposed.length ? <span className={page.tileMeta}>{proposed.length}</span> : null}
        <span className={page.grow} />
        <Button size="sm" variant="ghost" loading={busy} onClick={() => void learn()}>
          <Icon icon={Sparkles} />
          {L('重新分析', 'Analyze again')}
        </Button>
      </header>
      <div className={styles.adviceList}>
        {proposed.length ? (
          proposed.map((skill) => (
            <article key={skill.id} className={styles.ruleCard}>
              <div className={styles.ruleCardHead}>
                <strong>{skill.name}</strong>
                <span className={styles.confidence} title={L('把握程度', 'Confidence')}>
                  <span className={styles.confidenceTrack}>
                    <i style={{ width: `${Math.round(Math.max(0, Math.min(1, skill.confidence || 0)) * 100)}%` }} />
                  </span>
                  {Math.round((skill.confidence || 0) * 100)}%
                </span>
              </div>
              <p className={styles.ruleText}>{skill.rule}</p>
              {skill.evidence || skill.source ? (
                <p className={styles.ruleEvidence}>{[skill.source, skill.evidence].filter(Boolean).join(' · ')}</p>
              ) : null}
              <div className={styles.ruleActions}>
                <Button size="sm" variant="primary" onClick={() => accept(skill)}>{L('写进规则', 'Add to rules')}</Button>
                <Button size="sm" variant="bare" onClick={() => dismiss(skill)}>{L('忽略', 'Dismiss')}</Button>
              </div>
            </article>
          ))
        ) : (
          <p className={styles.quietLine}>{L('点「重新分析」，从现有数据和你改稿的习惯里，找出值得坚持的做法。', 'Press “Analyze again” to find what is worth keeping from your data and your edits.')}</p>
        )}
      </div>
    </section>
  );
}

export function RulesTile({ skills, className }: { skills: WorkbenchSkill[]; className?: string }) {
  const L = useL();
  const rules = skills.filter((skill) => skill.status === 'active' || skill.status === 'exported');
  const [editing, setEditing] = useState<WorkbenchSkill | 'new' | null>(null);
  const [exporting, setExporting] = useState(false);
  const [exported, setExported] = useState<{ name: string; path: string; rules: number } | null>(null);

  const exportSkill = async () => {
    setExporting(true);
    try {
      const response = await workbenchApi.exportSkills();
      workbench.setState(response.state);
      setExported({ name: response.name, path: response.path, rules: response.rules });
      toast({ title: L(`已导出为 Fantay Skill「${response.name}」`, `Exported as Fantay Skill “${response.name}”`), tone: 'success' });
    } catch (error) {
      reportError(error, L('导出失败', 'Export failed'));
    } finally {
      setExporting(false);
    }
  };

  const copyPath = async (path: string) => {
    try {
      await navigator.clipboard.writeText(path);
      toast({ title: L('已复制路径', 'Path copied') });
    } catch (error) {
      reportError(error);
    }
  };

  return (
    <section className={cn(page.tile, page.rise, className)} aria-label={L('写作规则', 'Writing rules')}>
      <header className={page.tileHead}>
        <h2 className={page.tileTitle}>{L('写作规则', 'Writing rules')}</h2>
        <span className={page.tileMeta}>{L('每次成稿都会遵守', 'Every draft follows these')}</span>
        <span className={page.grow} />
        <IconButton size="sm" aria-label={L('添加规则', 'Add a rule')} onClick={() => setEditing('new')}>
          <Icon icon={Plus} />
        </IconButton>
        <Button
          size="sm"
          variant="ghost"
          loading={exporting}
          disabled={!rules.length}
          disabledReason={L('先启用至少一条规则', 'Enable at least one rule first')}
          onClick={() => void exportSkill()}
        >
          <Icon icon={Download} />
          {L('导出为 Fantay Skill', 'Export as Fantay Skill')}
        </Button>
      </header>
      {exported ? (
        <div className={styles.exported}>
          <Callout tone="success">
            <div className={styles.exportedRow}>
              <span className={styles.exportedText}>
                {L(`「${exported.name}」· ${exported.rules} 条规则，已保存到`, `“${exported.name}” · ${exported.rules} rule${exported.rules === 1 ? '' : 's'}, saved to`)}
                <code className={styles.path}>{exported.path}</code>
              </span>
              <IconButton size="xs" aria-label={L('复制路径', 'Copy path')} onClick={() => void copyPath(exported.path)}>
                <Icon icon={Copy} />
              </IconButton>
            </div>
          </Callout>
        </div>
      ) : null}
      <ul className={styles.rules}>
        {rules.map((skill) => (
          <li key={skill.id} className={styles.rule}>
            <div className={styles.ruleBody}>
              <strong>
                {skill.name}
                {skill.status === 'exported' ? <span className={styles.ruleTag}>{L('已导出', 'Exported')}</span> : null}
              </strong>
              <p>{skill.rule}</p>
            </div>
            <div className={styles.ruleRowActions}>
              <Button
                size="sm"
                variant="bare"
                onClick={() => void workbench.ops([{ op: 'update_skill', id: skill.id, status: 'proposed' }], { label: L(`停用规则「${skill.name}」`, `Pause rule “${skill.name}”`) })}
              >
                {L('停用', 'Pause')}
              </Button>
              <IconButton size="sm" aria-label={L(`编辑规则「${skill.name}」`, `Edit rule “${skill.name}”`)} tooltip={L('编辑', 'Edit')} onClick={() => setEditing(skill)}>
                <Icon icon={Pencil} />
              </IconButton>
              <IconButton
                size="sm"
                variant="danger"
                aria-label={L(`删除规则「${skill.name}」`, `Delete rule “${skill.name}”`)}
                tooltip={L('删除', 'Delete')}
                onClick={() => void workbench.ops([{ op: 'delete_skill', id: skill.id }], { label: L(`删除规则「${skill.name}」`, `Delete rule “${skill.name}”`) })}
              >
                <Icon icon={Trash2} />
              </IconButton>
            </div>
          </li>
        ))}
        {!rules.length ? (
          <li className={styles.quietLine}>
            {L('采纳一条建议，或在助手里说「以后标题都不要超过 20 个字」，这里就会多一条。', 'Accept a suggestion, or tell the assistant “keep titles under 20 words”, and a rule appears here.')}
          </li>
        ) : null}
      </ul>
      <RuleDialog skill={editing} onClose={() => setEditing(null)} />
    </section>
  );
}

function RuleDialog({ skill: liveSkill, onClose }: { skill: WorkbenchSkill | 'new' | null; onClose(): void }) {
  const skill = useLastDefined(liveSkill);
  const L = useL();
  const ids = { name: useId(), rule: useId() };
  const [name, setName] = useState('');
  const [rule, setRule] = useState('');
  const [busy, setBusy] = useState(false);
  const open = liveSkill !== null;
  const existing = skill && skill !== 'new' ? skill : null;

  useEffect(() => {
    if (!open) return;
    setName(existing?.name ?? '');
    setRule(existing?.rule ?? '');
    setBusy(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, existing?.id]);

  const valid = name.trim() && rule.trim();
  const save = async () => {
    if (!valid || busy) return;
    setBusy(true);
    const response = existing
      ? await workbench.ops([{ op: 'update_skill', id: existing.id, name: name.trim(), rule: rule.trim() }], { label: L('修改规则', 'Edit rule') })
      : await workbench.ops([{ op: 'add_skill', name: name.trim(), rule: rule.trim(), status: 'active', source: L('手动', 'Manual'), confidence: 1 }], { label: L('添加规则', 'Add rule') });
    setBusy(false);
    if (response && !response.errors.length) onClose();
  };

  return (
    <WbModal
      open={open}
      onClose={onClose}
      title={existing ? L('编辑规则', 'Edit rule') : L('添加写作规则', 'Add a writing rule')}
      lede={L('规则会写进每一次成稿的要求里。', 'Rules are added to every production’s instructions.')}
      onSubmit={() => void save()}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>{L('取消', 'Cancel')}</Button>
          <Button type="submit" variant="primary" loading={busy} disabled={!valid}>{L('保存', 'Save')}</Button>
        </>
      }
    >
      <Field label={L('名字', 'Name')} htmlFor={ids.name} labelVariant="form">
        <Input id={ids.name} value={name} required autoFocus placeholder={L('比如：标题写读者原话', 'e.g. Titles quote the reader')} onChange={(event) => setName(event.target.value)} />
      </Field>
      <Field label={L('规则', 'Rule')} htmlFor={ids.rule} labelVariant="form">
        <Textarea id={ids.rule} rows={4} value={rule} required placeholder={L('一句话写清楚要怎么做，比如：标题不超过 20 个字。', 'Say exactly what to do, e.g. keep titles under 20 words.')} onChange={(event) => setRule(event.target.value)} />
      </Field>
    </WbModal>
  );
}
