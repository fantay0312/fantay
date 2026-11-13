/*
 * SPDX-License-Identifier: AGPL-3.0-only
 * Fantay 工作台 · 复盘 — data entry: 手动录入 one row (`add_metric`), or paste a CSV, preview what
 * will be imported and import every good row in one undoable batch.
 * Derived from dsh-media-desk client/insights.jsx (https://github.com/woniuniuniu/dsh-media-desk),
 * MIT, Copyright (c) 2026 woniuniuniu.
 */
import { useEffect, useId, useMemo, useState } from 'react';
import type { WorkbenchItem, WorkbenchPlatform } from '@open-design/contracts';
import {
  Button,
  Callout,
  Field,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Textarea,
  toast,
} from '../../ui';
import { useL, useWorkbenchLang } from '../lang';
import { dayKey, displayItem, fmtDate, platformChoices, platformName } from '../shared/format';
import { workbench } from '../store';
import { Choices, WbModal, WbSection } from '../pages-shared/WbModal';
import { csvRowsToOps, parseMetricsCsv } from './csv';
import styles from './InsightsPage.module.css';

const NO_ITEM = '__none__';
const NUMBER_FIELDS = ['views', 'likes', 'comments', 'shares', 'saves'] as const;
type NumberField = (typeof NUMBER_FIELDS)[number];

export function MetricDialog({ open, onClose, items }: { open: boolean; onClose(): void; items: WorkbenchItem[] }) {
  const L = useL();
  const lang = useWorkbenchLang();
  const ids = { item: useId(), date: useId(), num: useId() };
  const [itemId, setItemId] = useState(NO_ITEM);
  const [platform, setPlatform] = useState<WorkbenchPlatform>('公众号');
  const [date, setDate] = useState(() => dayKey(new Date()));
  const [values, setValues] = useState<Record<NumberField, string>>({ views: '', likes: '', comments: '', shares: '', saves: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setItemId(NO_ITEM);
    setPlatform(platformChoices(lang)[0] ?? '公众号');
    setDate(dayKey(new Date()));
    setValues({ views: '', likes: '', comments: '', shares: '', saves: '' });
    setBusy(false);
    setError(null);
  }, [open, lang]);

  const choices = useMemo(
    () =>
      items
        .filter((item) => !item.parentId)
        .sort((a, b) => (a.status === 'published' ? 0 : 1) - (b.status === 'published' ? 0 : 1) || Date.parse(b.createdAt) - Date.parse(a.createdAt))
        .slice(0, 200),
    [items],
  );

  const labels: Record<NumberField, string> = {
    views: L('播放 / 阅读', 'Views / reads'),
    likes: L('点赞', 'Likes'),
    comments: L('评论', 'Comments'),
    shares: L('分享', 'Shares'),
    saves: L('收藏', 'Saves'),
  };

  const submit = async () => {
    if (busy) return;
    const day = new Date(`${date}T12:00:00`);
    if (!date || Number.isNaN(day.getTime())) {
      setError(L('填一个日期', 'Enter a date'));
      return;
    }
    const n = (key: NumberField) => Math.max(0, Math.round(Number(values[key]) || 0));
    if (!NUMBER_FIELDS.some((key) => n(key) > 0)) {
      setError(L('至少填一个数字', 'Enter at least one number'));
      return;
    }
    setBusy(true);
    const response = await workbench.ops(
      [{ op: 'add_metric', itemId: itemId === NO_ITEM ? null : itemId, platform, date: day.toISOString(), views: n('views'), likes: n('likes'), comments: n('comments'), shares: n('shares'), saves: n('saves') }],
      { label: L('录入数据', 'Add data') },
    );
    setBusy(false);
    if (response && !response.errors.length) onClose();
  };

  return (
    <WbModal
      open={open}
      onClose={onClose}
      size="lg"
      title={L('录入一条数据', 'Add a data point')}
      lede={L('发布之后的播放和互动，录进来就会进复盘。', 'Views and engagement after publishing feed the review.')}
      onSubmit={() => void submit()}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>{L('取消', 'Cancel')}</Button>
          <Button type="submit" variant="primary" loading={busy}>{L('录入', 'Add')}</Button>
        </>
      }
    >
      <Field label={L('对应内容', 'Content')} htmlFor={ids.item} labelVariant="form" hint={L('关联后，这条数据会算进这篇内容的表现。', 'Linked data counts toward that piece’s results.')}>
        <Select
          value={itemId}
          onValueChange={(value) => {
            setItemId(value);
            const item = choices.find((row) => row.id === value);
            if (item?.platform) setPlatform(item.platform);
          }}
        >
          <SelectTrigger id={ids.item} className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NO_ITEM}>{L('不关联内容', 'Not linked')}</SelectItem>
            {choices.map((item) => (
              <SelectItem key={item.id} value={item.id}>
                {displayItem(item).title.slice(0, 40)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
      <WbSection title={L('平台', 'Platform')}>
        <Choices
          label={L('平台', 'Platform')}
          value={platform}
          onChange={(value) => setPlatform(value as WorkbenchPlatform)}
          options={platformChoices(lang).map((p) => ({ value: p, label: platformName(p, lang) }))}
        />
      </WbSection>
      <Field label={L('日期', 'Date')} htmlFor={ids.date} labelVariant="form">
        <Input id={ids.date} type="date" value={date} required onChange={(event) => setDate(event.target.value)} style={{ maxWidth: 220 }} />
      </Field>
      <WbSection title={L('数字', 'Numbers')} hint={L('小红书、抖音没有播放量，可以只填互动。', 'Xiaohongshu and Douyin have no views — engagement alone is fine.')}>
        <div className={styles.numberGrid}>
          {NUMBER_FIELDS.map((key) => (
            <Field key={key} label={labels[key]} htmlFor={`${ids.num}-${key}`} labelVariant="caption">
              <Input
                id={`${ids.num}-${key}`}
                type="number"
                inputMode="numeric"
                min={0}
                step={1}
                value={values[key]}
                placeholder="0"
                onChange={(event) => {
                  setValues((current) => ({ ...current, [key]: event.target.value }));
                  setError(null);
                }}
              />
            </Field>
          ))}
        </div>
      </WbSection>
      {error ? <Callout tone="error">{error}</Callout> : null}
    </WbModal>
  );
}

export function CsvDialog({ open, onClose }: { open: boolean; onClose(): void }) {
  const L = useL();
  const lang = useWorkbenchLang();
  const id = useId();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) {
      setText('');
      setBusy(false);
    }
  }, [open]);

  const result = useMemo(() => parseMetricsCsv(text), [text]);
  const { rows, problems } = result;

  const submit = async () => {
    if (busy || !rows.length) return;
    setBusy(true);
    const response = await workbench.ops(csvRowsToOps(rows), {
      label: L(`导入 ${rows.length} 条数据`, `Import ${rows.length} data row${rows.length === 1 ? '' : 's'}`),
      quiet: true,
    });
    setBusy(false);
    if (response && !response.errors.length) {
      toast({
        title: L(`已导入 ${rows.length} 条数据`, `Imported ${rows.length} row${rows.length === 1 ? '' : 's'}`),
        ...(problems.length ? { description: L(`跳过了 ${problems.length} 行格式不对的`, `Skipped ${problems.length} malformed row${problems.length === 1 ? '' : 's'}`) } : {}),
        action: { label: L('撤销', 'Undo'), onClick: () => void workbench.undo() },
      });
      onClose();
    }
  };

  const reason = (r: 'platform' | 'date' | 'both') =>
    r === 'platform' ? L('认不出平台', 'unknown platform') : r === 'date' ? L('日期不对', 'bad date') : L('平台和日期都不对', 'platform and date unreadable');

  return (
    <WbModal
      open={open}
      onClose={onClose}
      size="xl"
      title={L('粘贴 CSV 数据', 'Paste CSV data')}
      lede={L('每行一条：平台,日期,播放,点赞,评论,分享,收藏。可以直接从表格里复制。', 'One row per line: platform,date,views,likes,comments,shares,saves. Copying from a spreadsheet works.')}
      onSubmit={() => void submit()}
      footer={
        <>
          <span className={styles.csvCount}>
            {text.trim()
              ? L(`可导入 ${rows.length} 行${problems.length ? `，${problems.length} 行格式不对` : ''}`, `${rows.length} row${rows.length === 1 ? '' : 's'} ready${problems.length ? `, ${problems.length} malformed` : ''}`)
              : ''}
          </span>
          <span style={{ flex: 1 }} />
          <Button variant="ghost" onClick={onClose}>{L('取消', 'Cancel')}</Button>
          <Button type="submit" variant="primary" loading={busy} disabled={!rows.length}>
            {rows.length ? L(`导入 ${rows.length} 行`, `Import ${rows.length}`) : L('导入', 'Import')}
          </Button>
        </>
      }
    >
      <Field htmlFor={id}>
        <Textarea
          id={id}
          rows={7}
          value={text}
          autoFocus
          spellCheck={false}
          className={styles.csvInput}
          placeholder={L('公众号,2026-10-30,3200,120,18,40,66\n小红书,2026-10-31,0,860,95,40,512', 'YouTube,2026-10-30,3200,120,18,40,66\nInstagram,2026-10-31,0,860,95,40,512')}
          onChange={(event) => setText(event.target.value)}
        />
      </Field>
      {rows.length ? (
        <WbSection title={L('预览', 'Preview')} hint={rows.length > 8 ? L(`前 8 行，共 ${rows.length} 行`, `First 8 of ${rows.length}`) : undefined}>
          <div className={styles.previewWrap}>
            <table className={styles.preview}>
              <thead>
                <tr>
                  <th>{L('行', 'Line')}</th>
                  <th>{L('平台', 'Platform')}</th>
                  <th>{L('日期', 'Date')}</th>
                  <th className={styles.isNum}>{L('播放', 'Views')}</th>
                  <th className={styles.isNum}>{L('点赞', 'Likes')}</th>
                  <th className={styles.isNum}>{L('评论', 'Comments')}</th>
                  <th className={styles.isNum}>{L('分享', 'Shares')}</th>
                  <th className={styles.isNum}>{L('收藏', 'Saves')}</th>
                </tr>
              </thead>
              <tbody>
                {rows.slice(0, 8).map((row) => (
                  <tr key={row.line}>
                    <td className={styles.previewLine}>{row.line}</td>
                    <td>{platformName(row.platform, lang)}</td>
                    <td>{fmtDate(row.date, lang)}</td>
                    <td className={styles.isNum}>{row.views.toLocaleString()}</td>
                    <td className={styles.isNum}>{row.likes.toLocaleString()}</td>
                    <td className={styles.isNum}>{row.comments.toLocaleString()}</td>
                    <td className={styles.isNum}>{row.shares.toLocaleString()}</td>
                    <td className={styles.isNum}>{row.saves.toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </WbSection>
      ) : null}
      {problems.length ? (
        <Callout tone="error">
          <p className={styles.problemTitle}>{L(`${problems.length} 行不会导入`, `${problems.length} row${problems.length === 1 ? '' : 's'} won’t import`)}</p>
          <ul className={styles.problemList}>
            {problems.slice(0, 5).map((problem) => (
              <li key={problem.line}>
                <span>{L(`第 ${problem.line} 行`, `Line ${problem.line}`)}</span> {reason(problem.reason)} · <code>{problem.text.slice(0, 60)}</code>
              </li>
            ))}
          </ul>
        </Callout>
      ) : null}
    </WbModal>
  );
}
