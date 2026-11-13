/*
 * SPDX-License-Identifier: AGPL-3.0-only
 * Fantay 工作台 — workbench settings. Every model call runs on the signed-in TokenToSea account, so there
 * are no keys here: pick the text and image models (自动 = the first usable one), how a production is
 * drawn (aspect, figures, storyboard length, images by default), how it is written (requirements,
 * language), where it is saved, and whether new captures are organised by AI. 试画一张 proves the image
 * model end to end.
 * Derived from dsh-media-desk client/settings.jsx and client/modelpick.jsx
 * (https://github.com/woniuniuniu/dsh-media-desk), MIT, Copyright (c) 2026 woniuniuniu.
 */
import { useEffect, useState, type ReactNode } from 'react';
import { CircleCheck, LogIn, Minus, Plus, UserRound } from 'lucide-react';
import type { WorkbenchLanguage, WorkbenchModelsResponse, WorkbenchSettings } from '@open-design/contracts';
import { workbenchMediaUrl } from '@open-design/contracts';

import { Button } from '../../ui/button';
import { Callout } from '../../ui/callout';
import { cn } from '../../ui/cn';
import { Modal, ModalActions, ModalLede, ModalSpacer, ModalTitle } from '../../ui/dialog';
import { IconButton } from '../../ui/icon-button';
import { Icon } from '../../ui/icons';
import { Input } from '../../ui/input';
import { Segmented, SegmentedItem } from '../../ui/segmented';
import { Skeleton } from '../../ui/skeleton';
import { Switch } from '../../ui/switch';
import { Textarea } from '../../ui/textarea';
import { toast } from '../../ui/toast';
import { workbenchApi } from '../api';
import { useL } from '../lang';
import { useWorkbenchShell } from '../shell/context';
import { errorMessage, useWorkbench } from '../store';
import { ModelSelect } from './ModelSelect';
import styles from './Settings.module.css';

type Form = WorkbenchSettings;

function pickForm(settings: WorkbenchSettings): Form {
  return {
    textModel: settings.textModel ?? '',
    imageModel: settings.imageModel ?? '',
    imageAspect: settings.imageAspect ?? '3:2',
    voice: settings.voice ?? '',
    exportDir: settings.exportDir ?? '',
    generateImages: settings.generateImages !== false,
    imageCount: settings.imageCount ?? 2,
    shotCount: settings.shotCount ?? 6,
    language: settings.language ?? 'auto',
    autoOrganize: settings.autoOrganize !== false,
  };
}

export interface SettingsDialogProps {
  open: boolean;
  onClose(): void;
}

export function SettingsDialog({ open, onClose }: SettingsDialogProps) {
  const L = useL();
  const shell = useWorkbenchShell();
  const snapshot = useWorkbench();
  const settings = shell.settings;
  const [form, setForm] = useState<Form | null>(null);
  const [models, setModels] = useState<WorkbenchModelsResponse | null>(null);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [sample, setSample] = useState<string | null>(null);
  const [testError, setTestError] = useState<string | null>(null);
  const signedIn = settings?.signedIn ?? snapshot.signedIn;

  // Fresh values every time it opens.
  useEffect(() => {
    if (!open) return;
    setSample(null);
    setTestError(null);
    void shell.reloadSettings();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  useEffect(() => {
    if (open && settings) setForm(current => current ?? pickForm(settings));
    if (!open) setForm(null);
  }, [open, settings]);
  useEffect(() => {
    if (!open) return undefined;
    let alive = true;
    setModels(null);
    setModelsError(null);
    workbenchApi.models()
      .then((next) => { if (alive) setModels(next); })
      .catch((error: unknown) => { if (alive) setModelsError(errorMessage(error)); });
    return () => { alive = false; };
  }, [open, signedIn]);

  const set = <K extends keyof Form>(key: K, value: Form[K]) => setForm(current => (current ? { ...current, [key]: value } : current));

  const persist = async (): Promise<boolean> => {
    if (!form) return false;
    try {
      const next = await workbenchApi.updateSettings({
        ...form,
        imageCount: clamp(form.imageCount, 0, 4),
        shotCount: clamp(form.shotCount, 0, 12),
        exportDir: form.exportDir.trim(),
      });
      shell.setSettings(next);
      return true;
    } catch (error) {
      toast({ title: L('设置没保存成功', 'Settings were not saved'), description: errorMessage(error), tone: 'danger' });
      return false;
    }
  };

  const save = async () => {
    setSaving(true);
    const ok = await persist();
    setSaving(false);
    if (ok) {
      toast({ title: L('设置已保存', 'Settings saved'), tone: 'success' });
      onClose();
    }
  };

  const test = async () => {
    setTesting(true);
    setSample(null);
    setTestError(null);
    // The test draws with what is on screen, so save first.
    if (await persist()) {
      try {
        const { src } = await workbenchApi.testImage();
        setSample(workbenchMediaUrl(src) ?? src);
      } catch (error) {
        setTestError(errorMessage(error));
      }
    }
    setTesting(false);
  };

  return (
    <Modal open={open} onClose={onClose} size="lg" className={styles.dialog}>
      <ModalTitle>{L('工作台设置', 'Workbench settings')}</ModalTitle>
      <ModalLede>{L('写作、生图和导入账号都使用你的 TokenToSea 账户，不需要填写任何密钥。', 'Writing, images and account import all run on your TokenToSea account. No keys needed.')}</ModalLede>

      {!form || !settings ? (
        <div className={styles.loading}>
          <Skeleton shape="row" />
          <Skeleton shape="row" index={1} />
          <Skeleton shape="row" index={2} />
        </div>
      ) : (
        <div className={styles.body}>
          <section className={cn(styles.account, signedIn && styles.accountOn)}>
            <span className={styles.accountIcon}><Icon icon={signedIn ? CircleCheck : UserRound} size={18} /></span>
            <div className={styles.accountText}>
              <b>{signedIn ? L('已登录 TokenToSea', 'Signed in to TokenToSea') : L('还没登录 TokenToSea', 'Not signed in to TokenToSea')}</b>
              <span>
                {signedIn
                  ? [
                      settings.textModelLabel ? L(`写作：${settings.textModelLabel}`, `Writing: ${settings.textModelLabel}`) : L('没有可用的文字模型', 'No text model available'),
                      settings.imageModelLabel ? L(`生图：${settings.imageModelLabel}`, `Images: ${settings.imageModelLabel}`) : L('没有可用的生图模型', 'No image model available'),
                    ].join(' · ')
                  : L('登录后，模型列表、一键成稿、生图和账号导入才可用，费用记在你的账户里。', 'Sign in to load models and to produce, draw and import. Usage is billed to your account.')}
              </span>
            </div>
            {!signedIn ? (
              <Button variant="primary" size="sm" loading={shell.signingIn} onClick={shell.signIn}>
                <Icon icon={LogIn} size={14} />
                {L('登录', 'Sign in')}
              </Button>
            ) : null}
          </section>

          <Group title={L('模型', 'Models')}>
            <Row label={L('文字模型', 'Text model')} hint={L('写作和助手用它。自动 = 账户里第一个可用的模型。', 'Used for writing and the assistant. Auto = the first usable model.')}>
              <ModelSelect
                kind="text"
                value={form.textModel}
                autoLabel={settings.textModelLabel}
                models={models?.text ?? null}
                error={modelsError}
                signedIn={signedIn}
                onChange={value => set('textModel', value)}
              />
            </Row>
            <Row label={L('生图模型', 'Image model')} hint={L('画封面、配图和分镜。', 'Draws covers, figures and storyboards.')}>
              <ModelSelect
                kind="image"
                value={form.imageModel}
                autoLabel={settings.imageModelLabel}
                models={models?.image ?? null}
                error={modelsError}
                signedIn={signedIn}
                onChange={value => set('imageModel', value)}
              />
            </Row>
          </Group>

          <Group title={L('成稿', 'Production')}>
            <Row label={L('默认生成图片', 'Draw images by default')} hint={L('每次成稿前还可以单独改。', 'You can still change it per run.')}>
              <Switch checked={form.generateImages} onCheckedChange={value => set('generateImages', value)} aria-label={L('默认生成图片', 'Draw images by default')} />
            </Row>
            <Row stacked label={L('图片比例', 'Image aspect')} hint={L('封面和配图的画幅；视频封面会按 16:9 裁切。', 'For covers and figures; the video cover is cropped to 16:9.')}>
              <Segmented aria-label={L('图片比例', 'Image aspect')} className={styles.full} value={form.imageAspect} onValueChange={value => set('imageAspect', value as Form['imageAspect'])}>
                <SegmentedItem value="3:2">{L('横图 3:2', 'Landscape 3:2')}</SegmentedItem>
                <SegmentedItem value="1:1">{L('方图 1:1', 'Square 1:1')}</SegmentedItem>
                <SegmentedItem value="2:3">{L('竖图 2:3', 'Portrait 2:3')}</SegmentedItem>
              </Segmented>
            </Row>
            <Row stacked label={L('配图数量', 'Figures')} hint={L('插在文章里的图，0 表示不配图。', 'Images placed in the article; 0 for none.')}>
              <Segmented aria-label={L('配图数量', 'Figures')} className={styles.full} value={String(form.imageCount)} onValueChange={value => set('imageCount', Number(value))}>
                {[0, 1, 2, 3, 4].map(n => <SegmentedItem key={n} value={String(n)}>{n}</SegmentedItem>)}
              </Segmented>
            </Row>
            <Row label={L('分镜数量', 'Storyboard shots')} hint={L('0–12 格，0 表示不出分镜。', '0–12 shots; 0 for none.')}>
              <Stepper value={form.shotCount} min={0} max={12} label={L('分镜数量', 'Storyboard shots')} onChange={value => set('shotCount', value)} />
            </Row>
            <Row label={L('试画一张', 'Test image')} hint={L('用现在的设置画一张，会消耗一次生图额度。', 'Draws one image with these settings; uses image credits once.')}>
              <Button variant="default" loading={testing} disabled={!signedIn} disabledReason={!signedIn ? L('先登录 TokenToSea', 'Sign in first') : undefined} onClick={() => { void test(); }}>
                {L('试画一张', 'Draw a test')}
              </Button>
            </Row>
            {sample || testError || testing ? (
              <div className={styles.sample}>
                {testing ? <Skeleton shape="tile" aspect={form.imageAspect === '3:2' ? '5/3' : '4/3'} /> : null}
                {sample ? <img src={sample} alt={L('试画结果', 'Test image')} /> : null}
                {testError ? <Callout tone="error">{testError}</Callout> : null}
              </div>
            ) : null}
          </Group>

          <Group title={L('写作', 'Writing')}>
            <Row stacked label={L('写作语言', 'Writing language')} hint={L('标题、脚本和分镜用什么语言写。', 'The language titles, scripts and shots are written in.')}>
              <Segmented aria-label={L('写作语言', 'Writing language')} className={styles.full} value={form.language} onValueChange={value => set('language', value as WorkbenchLanguage)}>
                <SegmentedItem value="auto">{L('跟随界面', 'Follow the app')}</SegmentedItem>
                <SegmentedItem value="zh">中文</SegmentedItem>
                <SegmentedItem value="en">English</SegmentedItem>
              </Segmented>
            </Row>
            <Row stacked label={L('写作要求', 'Writing requirements')} hint={L('每次成稿都会带上，比如「口语化，不用感叹号」。', 'Added to every production, e.g. “conversational, no exclamation marks”.')}>
              <Textarea rows={3} value={form.voice} maxLength={2000} placeholder={L('写给 AI 的固定要求', 'Standing instructions for the writer')} onChange={event => set('voice', event.target.value)} />
            </Row>
          </Group>

          <Group title={L('灵感与导出', 'Library and export')}>
            <Row label={L('新捕获自动 AI 整理', 'Auto-organise new captures')} hint={L('自动补标题、标签、空间和摘要。', 'Fills in title, tags, space and summary.')}>
              <Switch checked={form.autoOrganize} onCheckedChange={value => set('autoOrganize', value)} aria-label={L('新捕获自动 AI 整理', 'Auto-organise new captures')} />
            </Row>
            <Row stacked label={L('导出文件夹', 'Export folder')} hint={L(`留空时保存到 ${settings.defaultExportDir}`, `Empty saves to ${settings.defaultExportDir}`)}>
              <Input value={form.exportDir} placeholder={settings.defaultExportDir} spellCheck={false} onChange={event => set('exportDir', event.target.value)} />
            </Row>
          </Group>
        </div>
      )}

      <ModalActions>
        <ModalSpacer />
        <Button variant="ghost" onClick={onClose}>{L('取消', 'Cancel')}</Button>
        <Button variant="primary" loading={saving} disabled={!form} onClick={() => { void save(); }}>{L('保存', 'Save')}</Button>
      </ModalActions>
    </Modal>
  );
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(Number.isFinite(value) ? value : min)));
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className={styles.group}>
      <h3 className={styles.groupTitle}>{title}</h3>
      <div className={styles.groupCard}>{children}</div>
    </section>
  );
}

function Row({ label, hint, stacked, children }: { label: string; hint?: string; stacked?: boolean; children: ReactNode }) {
  return (
    <div className={cn(styles.row, stacked && styles.rowStacked)}>
      <div className={styles.rowLabel}>
        <span className={styles.rowTitle}>{label}</span>
        {hint ? <span className={styles.rowHint}>{hint}</span> : null}
      </div>
      <div className={styles.rowControl}>{children}</div>
    </div>
  );
}

function Stepper({ value, min, max, label, onChange }: { value: number; min: number; max: number; label: string; onChange(value: number): void }) {
  const L = useL();
  return (
    <div className={styles.stepper} role="group" aria-label={label}>
      <IconButton size="sm" aria-label={L('减少', 'Fewer')} disabled={value <= min} onClick={() => onChange(Math.max(min, value - 1))}>
        <Icon icon={Minus} />
      </IconButton>
      <output className={styles.stepperValue} aria-live="polite">{value}</output>
      <IconButton size="sm" aria-label={L('增加', 'More')} disabled={value >= max} onClick={() => onChange(Math.min(max, value + 1))}>
        <Icon icon={Plus} />
      </IconButton>
    </div>
  );
}
