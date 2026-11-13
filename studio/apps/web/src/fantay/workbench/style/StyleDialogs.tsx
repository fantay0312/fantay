/*
 * SPDX-License-Identifier: AGPL-3.0-only
 * Fantay 工作台 · 风格 — edit every field of a style (`update_style`), and 提炼风格: paste your
 * own writing and/or up to five public links, the TokenToSea text model distils a style card.
 * Derived from dsh-media-desk client/style.jsx (https://github.com/woniuniuniu/dsh-media-desk),
 * MIT, Copyright (c) 2026 woniuniuniu.
 */
import { useEffect, useId, useState } from 'react';
import type { WorkbenchStyle } from '@open-design/contracts';
import { Button, Callout, Field, Input, Textarea, toast } from '../../ui';
import { workbenchApi } from '../api';
import { useL, useWorkbenchLang } from '../lang';
import { errorMessage, workbench } from '../store';
import { useLastDefined } from '../pages-shared/data';
import { WbModal, WbSection } from '../pages-shared/WbModal';
import styles from './StylePage.module.css';

const TEXT_FIELDS = ['tone', 'sentences', 'opening', 'structure', 'logic', 'story', 'flow'] as const;
type TextField = (typeof TEXT_FIELDS)[number];

interface StyleForm {
  name: string;
  icon: string;
  summary: string;
  tone: string;
  sentences: string;
  opening: string;
  structure: string;
  logic: string;
  story: string;
  flow: string;
  words: string;
  avoid: string;
  samples: string;
}

const splitList = (value: string) => value.split(/[、,，;；\n]/).map((v) => v.trim()).filter(Boolean);

function formOf(style: WorkbenchStyle | null, sep: string): StyleForm {
  return {
    name: style?.name ?? '',
    icon: style?.icon ?? '',
    summary: style?.summary ?? '',
    tone: style?.tone ?? '',
    sentences: style?.sentences ?? '',
    opening: style?.opening ?? '',
    structure: style?.structure ?? '',
    logic: style?.logic ?? '',
    story: style?.story ?? '',
    flow: style?.flow ?? '',
    words: (style?.words ?? []).join(sep),
    avoid: (style?.avoid ?? []).join(sep),
    samples: (style?.samples ?? []).join('\n'),
  };
}

export function StyleEditDialog({ style: liveStyle, onClose }: { style: WorkbenchStyle | null; onClose(): void }) {
  const style = useLastDefined(liveStyle);
  const L = useL();
  const lang = useWorkbenchLang();
  const sep = lang === 'en' ? ', ' : '、';
  const base = useId();
  const [form, setForm] = useState<StyleForm>(() => formOf(style, sep));
  const [busy, setBusy] = useState(false);
  const open = liveStyle !== null;

  useEffect(() => {
    if (!open) return;
    setForm(formOf(style, sep));
    setBusy(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, style?.id]);

  const set = (key: keyof StyleForm) => (event: { target: { value: string } }) => setForm((current) => ({ ...current, [key]: event.target.value }));

  const labels: Record<TextField, [string, string]> = {
    tone: [L('语气', 'Tone'), L('听起来像谁在说话', 'Who it sounds like')],
    sentences: [L('句式', 'Sentences'), L('句子长短、节奏、口头禅', 'Length, rhythm, verbal habits')],
    opening: [L('开头', 'Opening'), L('前三秒怎么抓人', 'How the first seconds hook')],
    structure: [L('结构', 'Structure'), L('从头到尾的走法', 'The path from start to end')],
    logic: [L('论证', 'Reasoning'), L('怎么讲道理、举证据', 'How points are argued')],
    story: [L('讲故事', 'Storytelling'), L('怎么用经历和细节', 'How experience and detail are used')],
    flow: [L('节奏', 'Flow'), L('段落之间怎么推进', 'How sections move along')],
  };

  const save = async () => {
    if (!style || busy || !form.name.trim()) return;
    setBusy(true);
    const response = await workbench.ops(
      [
        {
          op: 'update_style',
          id: style.id,
          name: form.name.trim(),
          icon: form.icon.trim(),
          summary: form.summary.trim(),
          ...Object.fromEntries(TEXT_FIELDS.map((key) => [key, form[key].trim()])),
          words: splitList(form.words),
          avoid: splitList(form.avoid),
          samples: form.samples.split('\n').map((line) => line.trim()).filter(Boolean),
        },
      ],
      { label: L('修改风格', 'Edit style') },
    );
    setBusy(false);
    if (response && !response.errors.length) onClose();
  };

  return (
    <WbModal
      open={open}
      onClose={onClose}
      size="xl"
      title={L('编辑风格', 'Edit style')}
      lede={style ? L(`改完之后，按「${style.name}」写的稿子都会照新的来。`, `Drafts written as “${style.name}” follow the new version.`) : undefined}
      onSubmit={() => void save()}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>{L('取消', 'Cancel')}</Button>
          <Button type="submit" variant="primary" loading={busy} disabled={!form.name.trim()}>{L('保存', 'Save')}</Button>
        </>
      }
    >
      <WbSection title={L('基本', 'Basics')}>
        <div className={styles.formRow}>
          <Field label={L('图标', 'Icon')} htmlFor={`${base}-icon`} labelVariant="caption" className={styles.iconField}>
            <Input id={`${base}-icon`} value={form.icon} maxLength={8} placeholder="✍️" onChange={set('icon')} className={styles.iconInput} />
          </Field>
          <Field label={L('名字', 'Name')} htmlFor={`${base}-name`} labelVariant="caption" className={styles.grow}>
            <Input id={`${base}-name`} value={form.name} required onChange={set('name')} />
          </Field>
        </div>
        <Field label={L('一句话概括', 'One-line summary')} htmlFor={`${base}-summary`} labelVariant="caption">
          <Textarea id={`${base}-summary`} rows={2} value={form.summary} onChange={set('summary')} />
        </Field>
      </WbSection>
      <WbSection title={L('怎么写', 'How it writes')}>
        <div className={styles.fieldGrid}>
          {TEXT_FIELDS.map((key) => (
            <Field key={key} label={labels[key][0]} hint={labels[key][1]} htmlFor={`${base}-${key}`} labelVariant="caption">
              <Textarea id={`${base}-${key}`} rows={2} value={form[key]} onChange={set(key)} />
            </Field>
          ))}
        </div>
      </WbSection>
      <WbSection title={L('用词', 'Words')} hint={L('用顿号或逗号分隔', 'Separate with commas')}>
        <div className={styles.fieldGrid}>
          <Field label={L('常用词', 'Signature words')} htmlFor={`${base}-words`} labelVariant="caption">
            <Input id={`${base}-words`} value={form.words} onChange={set('words')} />
          </Field>
          <Field label={L('绝不要', 'Never')} htmlFor={`${base}-avoid`} labelVariant="caption">
            <Input id={`${base}-avoid`} value={form.avoid} onChange={set('avoid')} />
          </Field>
        </div>
      </WbSection>
      <WbSection title={L('样句', 'Sample lines')} hint={L('一行一句，越像你越好', 'One per line, the more like you the better')}>
        <Textarea id={`${base}-samples`} aria-label={L('样句', 'Sample lines')} rows={4} value={form.samples} onChange={set('samples')} />
      </WbSection>
    </WbModal>
  );
}

const MAX_LINKS = 5;

export function ExtractStyleDialog({ open, onClose, onImport }: { open: boolean; onClose(): void; onImport(): void }) {
  const L = useL();
  const ids = { text: useId(), urls: useId(), name: useId() };
  const [text, setText] = useState('');
  const [urls, setUrls] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ id: string; failures: string[] } | null>(null);

  useEffect(() => {
    if (!open) return;
    setText('');
    setUrls('');
    setName('');
    setBusy(false);
    setError(null);
    setResult(null);
  }, [open]);

  const links = urls.split(/\s+/).map((u) => u.trim()).filter(Boolean);
  const badLinks = links.filter((u) => !/^https?:\/\/\S+$/i.test(u));
  const linkError = links.length > MAX_LINKS
    ? L(`最多 ${MAX_LINKS} 个链接，现在有 ${links.length} 个`, `Up to ${MAX_LINKS} links; you have ${links.length}`)
    : badLinks.length
      ? L(`这些不是链接：${badLinks.slice(0, 2).join('、')}`, `Not links: ${badLinks.slice(0, 2).join(', ')}`)
      : null;
  const ready = (text.trim().length > 0 || links.length > 0) && !linkError;

  const applyStyle = (id: string) => void workbench.ops([{ op: 'set_style', id }], { label: L('切换风格', 'Switch style') });

  const submit = async () => {
    if (result) {
      onClose();
      return;
    }
    if (!ready || busy) return;
    setBusy(true);
    setError(null);
    try {
      const response = await workbenchApi.extractStyle({
        ...(text.trim() ? { text: text.trim() } : {}),
        ...(links.length ? { urls: links } : {}),
        ...(name.trim() ? { name: name.trim() } : {}),
      });
      workbench.setState(response.state);
      const created = response.state.styles.find((style) => style.id === response.id);
      toast({
        title: L(`已提炼风格「${created?.name ?? name.trim()}」`, `Style “${created?.name ?? name.trim()}” is ready`),
        tone: 'success',
        action: { label: L('用这个写', 'Write with it'), onClick: () => applyStyle(response.id) },
      });
      if (response.failures.length) setResult({ id: response.id, failures: response.failures });
      else onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <WbModal
      open={open}
      onClose={onClose}
      size="lg"
      title={L('提炼我的风格', 'Extract my style')}
      lede={L('贴几篇你写过的稿子，或者你发过的内容链接。越多越准。', 'Paste a few pieces you wrote, or links to posts you published. More is better.')}
      onSubmit={() => void submit()}
      footer={
        result ? (
          <>
            <Button variant="ghost" onClick={() => applyStyle(result.id)}>{L('用这个写', 'Write with it')}</Button>
            <Button type="submit" variant="primary">{L('完成', 'Done')}</Button>
          </>
        ) : (
          <>
            {busy ? <span className={styles.busyHint}>{L('正在读内容、分析写法，通常要半分钟左右', 'Reading and analysing — usually about half a minute')}</span> : null}
            <span style={{ flex: 1 }} />
            <Button variant="ghost" onClick={onClose}>{L('取消', 'Cancel')}</Button>
            <Button type="submit" variant="primary" loading={busy} disabled={!ready}>{L('提炼风格', 'Extract style')}</Button>
          </>
        )
      }
    >
      {result ? (
        <Callout tone="error">
          <p className={styles.calloutTitle}>{L('风格已经提炼好，但这些链接没读到：', 'The style is ready, but these links could not be read:')}</p>
          <ul className={styles.failures}>
            {result.failures.map((failure) => (
              <li key={failure}>{failure}</li>
            ))}
          </ul>
        </Callout>
      ) : (
        <>
          <Field label={L('贴内容', 'Paste writing')} htmlFor={ids.text} labelVariant="form">
            <Textarea
              id={ids.text}
              rows={7}
              value={text}
              autoFocus
              placeholder={L('贴几篇你写过的稿子、脚本或文案。', 'Paste a few of your articles, scripts or captions.')}
              onChange={(event) => setText(event.target.value)}
            />
          </Field>
          <Field
            label={L(`贴链接（最多 ${MAX_LINKS} 个）`, `Paste links (up to ${MAX_LINKS})`)}
            htmlFor={ids.urls}
            labelVariant="form"
            error={linkError}
            hint={
              <>
                {L('只读公开页面。小红书、抖音、B 站、TikTok、Instagram 和 X 要登录才能看，', 'Public pages only. Xiaohongshu, Douyin, Bilibili, TikTok, Instagram and X need a login — ')}
                <Button
                  variant="link"
                  size="sm"
                  className={styles.inlineLink}
                  onClick={() => {
                    onClose();
                    onImport();
                  }}
                >
                  {L('改用导入账号', 'import the account instead')}
                </Button>
                {L('。', '.')}
              </>
            }
          >
            <Textarea
              id={ids.urls}
              rows={3}
              value={urls}
              placeholder={L('一行一个链接', 'One link per line')}
              aria-invalid={linkError ? true : undefined}
              onChange={(event) => setUrls(event.target.value)}
            />
          </Field>
          <Field label={L('名字（可选）', 'Name (optional)')} htmlFor={ids.name} labelVariant="form">
            <Input id={ids.name} value={name} placeholder={L('比如：我的口播风格', 'e.g. My spoken style')} onChange={(event) => setName(event.target.value)} />
          </Field>
          {error ? <Callout tone="error">{error}</Callout> : null}
        </>
      )}
    </WbModal>
  );
}
