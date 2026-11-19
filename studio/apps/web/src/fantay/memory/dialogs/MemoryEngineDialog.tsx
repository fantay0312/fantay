// SPDX-License-Identifier: AGPL-3.0-only
// 记忆引擎: how memories are found and how disagreements are noticed, as a heading plus hairline group
// blocks. The current state comes first in words (仅关键词 / 关键词 + 语义 / 关键词 + 语义 + 重排), then
// one block per choice with a full-width switch, then the advanced numbers folded away, then upkeep
// (重建索引, 整理一遍), which runs at once and does not wait for 保存. Keys are write-only. When this build
// can run local models, 本机模型 is the first choice for 语义搜索 and 重新排序: each model is downloaded
// here (progress is read again while it downloads) and runs on this computer.
import { Check } from 'lucide-react';
import { useEffect, useId, useState, type ReactNode } from 'react';
import type {
  MemoryAutoMode,
  MemoryEmbeddingProviderKind,
  MemoryEngineConfig,
  MemoryEngineResponse,
  MemoryEngineStatus,
  MemoryJudgeProviderKind,
  MemoryLocalModel,
  MemoryProviderState,
  MemoryRerankProviderKind,
  UpdateMemoryEngineConfigRequest,
} from '@open-design/contracts';

import { PaDisclosure } from '../../pa/PaDisclosure';
import { Button, CheckboxField, Field, Icon, Input, Progress, Segmented, SegmentedItem, cn, toast } from '../../ui';
import { memoryApi } from '../api';
import { ErrorNotice, Fact, LoadingBlock, Section, useLoader, useMemoryLabels, useSessionKey } from './dialog-kit';
import { MemoryDialogFrame } from './MemoryDialogFrame';
import frame from './MemoryDialogFrame.module.css';
import { useMemoryDialogT, type MemoryDialogKey, type MemoryDialogT } from './i18n';
import styles from './MemoryEngineDialog.module.css';

export interface MemoryEngineDialogProps {
  open: boolean;
  onOpenChange(open: boolean): void;
  onChanged(): void;
}

interface KeyDraft {
  value: string;
  /** Clear the stored key on save. */
  clear: boolean;
}

interface EngineDraft {
  autoMemory: MemoryAutoMode;
  embedding: { provider: MemoryEmbeddingProviderKind; baseUrl: string; model: string; dimensions: string; key: KeyDraft };
  reranker: { provider: MemoryRerankProviderKind; url: string; model: string; key: KeyDraft };
  judge: { provider: MemoryJudgeProviderKind; apiUrl: string; model: string; key: KeyDraft };
  recall: { maxHits: string; budgetChars: string; minScore: string };
}

const EMBEDDING: readonly MemoryEmbeddingProviderKind[] = ['off', 'ollama', 'openai_compatible'];
const RERANKER: readonly MemoryRerankProviderKind[] = ['builtin', 'http'];
const JUDGE: readonly MemoryJudgeProviderKind[] = ['heuristic', 'jev', 'llm'];
const AUTO: readonly MemoryAutoMode[] = ['off', 'review', 'auto'];
/** While a local model downloads, the engine status is read again this often. */
const DOWNLOAD_POLL_MS = 1000;

const NO_KEY: KeyDraft = { value: '', clear: false };

type LocalRole = MemoryLocalModel['role'];
type ModelAction = 'download' | 'cancel';

/** 本机模型 leads the choices when this build can run it; it stays listed while it is the saved choice,
 *  so a saved setting is never shown as nothing selected. */
function withLocal<T extends string>(options: readonly T[], local: T, offered: boolean): readonly T[] {
  return offered ? [local, ...options] : options;
}

function draftOf(config: MemoryEngineConfig): EngineDraft {
  return {
    autoMemory: config.autoMemory,
    embedding: {
      provider: config.embedding.provider,
      baseUrl: config.embedding.baseUrl,
      model: config.embedding.model,
      dimensions: String(config.embedding.dimensions),
      key: NO_KEY,
    },
    reranker: { provider: config.reranker.provider, url: config.reranker.url, model: config.reranker.model, key: NO_KEY },
    judge: { provider: config.judge.provider, apiUrl: config.judge.apiUrl, model: config.judge.model, key: NO_KEY },
    recall: {
      maxHits: String(config.recall.maxHits),
      budgetChars: String(config.recall.budgetChars),
      minScore: String(config.recall.minScore),
    },
  };
}

function keyUpdate(key: KeyDraft): { apiKey?: string } {
  const value = key.value.trim();
  if (value) return { apiKey: value };
  return key.clear ? { apiKey: '' } : {};
}

/** Only what changed, so an untouched section is not rewritten. */
function buildUpdate(config: MemoryEngineConfig, draft: EngineDraft): UpdateMemoryEngineConfigRequest {
  const update: UpdateMemoryEngineConfigRequest = {};
  if (draft.autoMemory !== config.autoMemory) update.autoMemory = draft.autoMemory;

  const embedding: NonNullable<UpdateMemoryEngineConfigRequest['embedding']> = { ...keyUpdate(draft.embedding.key) };
  if (draft.embedding.provider !== config.embedding.provider) embedding.provider = draft.embedding.provider;
  if (draft.embedding.baseUrl.trim() !== config.embedding.baseUrl) embedding.baseUrl = draft.embedding.baseUrl.trim();
  if (draft.embedding.model.trim() !== config.embedding.model) embedding.model = draft.embedding.model.trim();
  const dimensions = Number(draft.embedding.dimensions || '0');
  if (dimensions !== config.embedding.dimensions) embedding.dimensions = dimensions;
  if (Object.keys(embedding).length > 0) update.embedding = embedding;

  const reranker: NonNullable<UpdateMemoryEngineConfigRequest['reranker']> = { ...keyUpdate(draft.reranker.key) };
  if (draft.reranker.provider !== config.reranker.provider) reranker.provider = draft.reranker.provider;
  if (draft.reranker.url.trim() !== config.reranker.url) reranker.url = draft.reranker.url.trim();
  if (draft.reranker.model.trim() !== config.reranker.model) reranker.model = draft.reranker.model.trim();
  if (Object.keys(reranker).length > 0) update.reranker = reranker;

  const judge: NonNullable<UpdateMemoryEngineConfigRequest['judge']> = { ...keyUpdate(draft.judge.key) };
  if (draft.judge.provider !== config.judge.provider) judge.provider = draft.judge.provider;
  if (draft.judge.apiUrl.trim() !== config.judge.apiUrl) judge.apiUrl = draft.judge.apiUrl.trim();
  if (draft.judge.model.trim() !== config.judge.model) judge.model = draft.judge.model.trim();
  if (Object.keys(judge).length > 0) update.judge = judge;

  const recall: NonNullable<UpdateMemoryEngineConfigRequest['recall']> = {};
  const maxHits = Number(draft.recall.maxHits);
  const budgetChars = Number(draft.recall.budgetChars);
  const minScore = Number(draft.recall.minScore);
  if (maxHits !== config.recall.maxHits) recall.maxHits = maxHits;
  if (budgetChars !== config.recall.budgetChars) recall.budgetChars = budgetChars;
  if (minScore !== config.recall.minScore) recall.minScore = minScore;
  if (Object.keys(recall).length > 0) update.recall = recall;
  return update;
}

function isInt(value: string, min: number, max: number): boolean {
  const number = Number(value);
  return value.trim() !== '' && Number.isInteger(number) && number >= min && number <= max;
}

function invalidReason(draft: EngineDraft, t: MemoryDialogT): string | null {
  if (draft.embedding.provider === 'openai_compatible' && (!draft.embedding.baseUrl.trim() || !draft.embedding.model.trim())) {
    return t('engine.need.embedding');
  }
  if (draft.embedding.provider !== 'off' && !isInt(draft.embedding.dimensions || '0', 0, 4096)) return t('engine.need.dimensions');
  if (draft.reranker.provider === 'http' && !draft.reranker.url.trim()) return t('engine.need.reranker');
  const minScore = Number(draft.recall.minScore);
  if (
    !isInt(draft.recall.maxHits, 1, 40) ||
    !isInt(draft.recall.budgetChars, 500, 40000) ||
    draft.recall.minScore.trim() === '' ||
    !(minScore >= 0 && minScore <= 1)
  ) {
    return t('engine.need.numbers');
  }
  return null;
}

export function MemoryEngineDialog(props: MemoryEngineDialogProps) {
  const sessionKey = useSessionKey(props.open, 'engine');
  return <EngineSession key={sessionKey} {...props} />;
}

function EngineSession({ open, onOpenChange, onChanged }: MemoryEngineDialogProps) {
  const { t } = useMemoryDialogT();
  const engine = useLoader<MemoryEngineResponse>(open ? 'engine' : null, () => memoryApi.engine());
  const [draft, setDraft] = useState<EngineDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [upkeep, setUpkeep] = useState<'reindex' | 'tidy' | null>(null);
  const [withVectors, setWithVectors] = useState(false);
  const [modelBusy, setModelBusy] = useState<string | null>(null);
  const close = () => onOpenChange(false);
  const config = engine.data?.config ?? null;
  const status = engine.data?.status ?? null;
  const downloading = status?.localModels.some((model) => model.state === 'downloading') ?? false;
  const { reload: reloadEngine, replace: showEngine } = engine;

  // The form starts from the first answer; later status refreshes leave what the owner typed alone.
  useEffect(() => {
    if (config && !draft) setDraft(draftOf(config));
  }, [config, draft]);

  useEffect(() => {
    if (!open || !downloading) return undefined;
    const timer = setInterval(reloadEngine, DOWNLOAD_POLL_MS);
    return () => clearInterval(timer);
  }, [open, downloading, reloadEngine]);

  const modelAction = async (id: string, action: ModelAction) => {
    setModelBusy(id);
    setError(null);
    try {
      showEngine(await memoryApi.localModelAction(id, { action }));
    } catch (caught) {
      setError(caught);
    } finally {
      setModelBusy(null);
    }
  };

  const update = config && draft ? buildUpdate(config, draft) : null;
  const invalid = draft ? invalidReason(draft, t) : null;
  let blocked: string | null = null;
  if (!draft || !update) blocked = t('common.loading');
  else if (invalid) blocked = invalid;
  else if (Object.keys(update).length === 0) blocked = t('engine.need.change');

  const save = async () => {
    if (blocked || !update || saving) return;
    setSaving(true);
    setError(null);
    try {
      await memoryApi.updateEngine(update);
      toast({ id: 'memory-engine-saved', tone: 'success', title: t('engine.toast.saved'), description: t('engine.toast.savedBody') });
      onChanged();
      close();
    } catch (caught) {
      setError(caught);
    } finally {
      setSaving(false);
    }
  };

  const reindex = async () => {
    setUpkeep('reindex');
    setError(null);
    try {
      const result = await memoryApi.reindex(withVectors ? { vectors: true } : {});
      toast({
        id: 'memory-engine-reindex',
        tone: 'success',
        title: t('engine.toast.reindexed'),
        description: t('engine.toast.reindexedBody', { n: result.documents, s: (result.durationMs / 1000).toFixed(1) }),
      });
      engine.reload();
      onChanged();
    } catch (caught) {
      setError(caught);
    } finally {
      setUpkeep(null);
    }
  };

  const tidy = async () => {
    setUpkeep('tidy');
    setError(null);
    try {
      const result = await memoryApi.tidy({});
      toast({
        id: 'memory-engine-tidy',
        tone: 'success',
        title: t('engine.toast.tidied'),
        description:
          result.conflictsOpened > 0 || result.itemsProposed > 0
            ? t('engine.toast.tidiedFound', { scanned: result.scannedItems, conflicts: result.conflictsOpened, proposed: result.itemsProposed })
            : t('engine.toast.tidiedNothing', { scanned: result.scannedItems }),
      });
      engine.reload();
      onChanged();
    } catch (caught) {
      setError(caught);
    } finally {
      setUpkeep(null);
    }
  };

  const set = (change: (current: EngineDraft) => EngineDraft) => setDraft((current) => (current ? change(current) : current));

  return (
    <MemoryDialogFrame
      open={open}
      onClose={close}
      size="lg"
      testId="memory-engine-dialog"
      title={t('engine.title')}
      lede={t('engine.lede')}
      onSubmit={() => void save()}
      footer={
        <>
          <Button variant="ghost" onClick={close}>
            {t('common.cancel')}
          </Button>
          <Button
            type="submit"
            variant="primary"
            loading={saving}
            disabled={blocked !== null}
            disabledReason={blocked ?? undefined}
            data-testid="memory-engine-save"
          >
            {t('common.save')}
          </Button>
        </>
      }
    >
      {error ? <ErrorNotice error={error} fallback="error.save" /> : null}
      {engine.data && draft && config ? (
        <div className={frame.reveal}>
          <StatusBlock status={engine.data.status} t={t} />

          <Section
            title={t('engine.embedding.title')}
            note={t(engine.data.status.localRuntime ? 'engine.embedding.noteLocal' : 'engine.embedding.note')}
            testId="memory-engine-embedding"
          >
            <div className={frame.group}>
              <div className={frame.groupPad}>
                <Choice
                  label={t('engine.embedding.title')}
                  value={draft.embedding.provider}
                  options={withLocal(EMBEDDING, 'local', engine.data.status.localRuntime || config.embedding.provider === 'local')}
                  labelKey={(value) => `engine.embedding.${value}` as MemoryDialogKey}
                  testId="memory-engine-embedding-provider"
                  t={t}
                  onChange={(provider) => set((current) => ({ ...current, embedding: { ...current.embedding, provider } }))}
                />
                {draft.embedding.provider === 'local' ? (
                  <LocalModels
                    role="embedding"
                    status={engine.data.status}
                    busyId={modelBusy}
                    t={t}
                    onAction={(id, action) => void modelAction(id, action)}
                  />
                ) : draft.embedding.provider === 'off' ? null : (
                  <>
                    <div className={frame.fieldGrid}>
                      <TextField
                        label={t('engine.field.url')}
                        value={draft.embedding.baseUrl}
                        placeholder={draft.embedding.provider === 'ollama' ? 'http://127.0.0.1:11434' : 'https://…/v1'}
                        testId="memory-engine-embedding-url"
                        onChange={(baseUrl) => set((current) => ({ ...current, embedding: { ...current.embedding, baseUrl } }))}
                      />
                      <TextField
                        label={t('engine.field.model')}
                        value={draft.embedding.model}
                        placeholder={draft.embedding.provider === 'ollama' ? 'qwen3-embedding:0.6b' : ''}
                        testId="memory-engine-embedding-model"
                        onChange={(model) => set((current) => ({ ...current, embedding: { ...current.embedding, model } }))}
                      />
                      {draft.embedding.provider === 'openai_compatible' ? (
                        <>
                          <KeyField
                            stored={config.embedding.hasApiKey}
                            draft={draft.embedding.key}
                            t={t}
                            testId="memory-engine-embedding-key"
                            onChange={(key) => set((current) => ({ ...current, embedding: { ...current.embedding, key } }))}
                          />
                          <TextField
                            label={t('engine.field.dimensions')}
                            hint={t('engine.field.dimensionsHint')}
                            value={draft.embedding.dimensions}
                            inputMode="numeric"
                            testId="memory-engine-embedding-dimensions"
                            onChange={(dimensions) => set((current) => ({ ...current, embedding: { ...current.embedding, dimensions } }))}
                          />
                        </>
                      ) : null}
                    </div>
                    <p className={frame.caption}>
                      {draft.embedding.provider === 'ollama' ? t('engine.embedding.localNote') : t('engine.embedding.remoteNote')}
                    </p>
                  </>
                )}
              </div>
            </div>
          </Section>

          <Section
            title={t('engine.reranker.title')}
            note={t(engine.data.status.localRuntime ? 'engine.reranker.noteLocal' : 'engine.reranker.note')}
            testId="memory-engine-reranker"
          >
            <div className={frame.group}>
              <div className={frame.groupPad}>
                <Choice
                  label={t('engine.reranker.title')}
                  value={draft.reranker.provider}
                  options={withLocal(RERANKER, 'local', engine.data.status.localRuntime || config.reranker.provider === 'local')}
                  labelKey={(value) => `engine.reranker.${value}` as MemoryDialogKey}
                  testId="memory-engine-reranker-provider"
                  t={t}
                  onChange={(provider) => set((current) => ({ ...current, reranker: { ...current.reranker, provider } }))}
                />
                {draft.reranker.provider === 'local' ? (
                  <LocalModels
                    role="reranker"
                    status={engine.data.status}
                    busyId={modelBusy}
                    t={t}
                    onAction={(id, action) => void modelAction(id, action)}
                  />
                ) : draft.reranker.provider === 'http' ? (
                  <div className={frame.fieldGrid}>
                    <TextField
                      label={t('engine.field.url')}
                      value={draft.reranker.url}
                      placeholder="https://…/rerank"
                      testId="memory-engine-reranker-url"
                      onChange={(url) => set((current) => ({ ...current, reranker: { ...current.reranker, url } }))}
                    />
                    <TextField
                      label={t('engine.field.model')}
                      value={draft.reranker.model}
                      testId="memory-engine-reranker-model"
                      onChange={(model) => set((current) => ({ ...current, reranker: { ...current.reranker, model } }))}
                    />
                    <KeyField
                      stored={config.reranker.hasApiKey}
                      draft={draft.reranker.key}
                      t={t}
                      testId="memory-engine-reranker-key"
                      onChange={(key) => set((current) => ({ ...current, reranker: { ...current.reranker, key } }))}
                    />
                  </div>
                ) : (
                  <p className={frame.caption}>{t('engine.reranker.builtinNote')}</p>
                )}
              </div>
            </div>
          </Section>

          <Section title={t('engine.judge.title')} note={t('engine.judge.note')} testId="memory-engine-judge">
            <div className={frame.group}>
              <div className={frame.groupPad}>
                <Choice
                  label={t('engine.judge.title')}
                  value={draft.judge.provider}
                  options={JUDGE}
                  labelKey={(value) => `engine.judge.${value}` as MemoryDialogKey}
                  testId="memory-engine-judge-provider"
                  t={t}
                  onChange={(provider) => set((current) => ({ ...current, judge: { ...current.judge, provider } }))}
                />
                {draft.judge.provider === 'jev' ? (
                  <div className={frame.fieldGrid}>
                    <TextField
                      label={t('engine.field.url')}
                      value={draft.judge.apiUrl}
                      placeholder="https://api.typesafe.ai/v1"
                      testId="memory-engine-judge-url"
                      onChange={(apiUrl) => set((current) => ({ ...current, judge: { ...current.judge, apiUrl } }))}
                    />
                    <TextField
                      label={t('engine.field.model')}
                      value={draft.judge.model}
                      placeholder="jev-latest"
                      testId="memory-engine-judge-model"
                      onChange={(model) => set((current) => ({ ...current, judge: { ...current.judge, model } }))}
                    />
                    <KeyField
                      stored={config.judge.hasApiKey}
                      draft={draft.judge.key}
                      t={t}
                      testId="memory-engine-judge-key"
                      onChange={(key) => set((current) => ({ ...current, judge: { ...current.judge, key } }))}
                    />
                  </div>
                ) : null}
                <p className={frame.caption}>{t(`engine.judge.${draft.judge.provider}Note` as MemoryDialogKey)}</p>
              </div>
            </div>
          </Section>

          <Section title={t('engine.auto.title')} note={t('engine.auto.note')} testId="memory-engine-auto">
            <div className={frame.group}>
              <div className={frame.groupPad}>
                <Choice
                  label={t('engine.auto.title')}
                  value={draft.autoMemory}
                  options={AUTO}
                  labelKey={(value) => `engine.auto.${value}` as MemoryDialogKey}
                  testId="memory-engine-auto-mode"
                  t={t}
                  onChange={(autoMemory) => set((current) => ({ ...current, autoMemory }))}
                />
                <p className={frame.caption}>{t(`engine.auto.${draft.autoMemory}Note` as MemoryDialogKey)}</p>
              </div>
            </div>
          </Section>

          <PaDisclosure label={t('engine.advanced')} className={styles.advanced}>
            <div className={cn(frame.group, styles.advancedGroup)} data-testid="memory-engine-advanced">
              <NumberRow
                label={t('engine.recall.maxHits')}
                hint={t('engine.recall.maxHitsHint')}
                value={draft.recall.maxHits}
                min={1}
                max={40}
                step={1}
                testId="memory-engine-max-hits"
                onChange={(maxHits) => set((current) => ({ ...current, recall: { ...current.recall, maxHits } }))}
              />
              <NumberRow
                label={t('engine.recall.budget')}
                hint={t('engine.recall.budgetHint')}
                value={draft.recall.budgetChars}
                min={500}
                max={40000}
                step={500}
                testId="memory-engine-budget"
                onChange={(budgetChars) => set((current) => ({ ...current, recall: { ...current.recall, budgetChars } }))}
              />
              <NumberRow
                label={t('engine.recall.minScore')}
                hint={t('engine.recall.minScoreHint')}
                value={draft.recall.minScore}
                min={0}
                max={1}
                step={0.01}
                testId="memory-engine-min-score"
                onChange={(minScore) => set((current) => ({ ...current, recall: { ...current.recall, minScore } }))}
              />
            </div>
          </PaDisclosure>

          <Section title={t('engine.upkeep.title')} testId="memory-engine-upkeep">
            <div className={frame.group}>
              <div className={styles.upkeepRow}>
                <div className={styles.upkeepText}>
                  <span className={styles.upkeepLabel}>{t('engine.upkeep.reindex')}</span>
                  <span className={styles.upkeepHint}>{t('engine.upkeep.reindexHint')}</span>
                  {config.embedding.provider !== 'off' ? (
                    <CheckboxField
                      className={styles.upkeepCheck}
                      label={t('engine.upkeep.withVectors')}
                      checked={withVectors}
                      onChange={(event) => setWithVectors(event.target.checked)}
                      data-testid="memory-engine-reindex-vectors"
                    />
                  ) : null}
                </div>
                <Button
                  size="sm"
                  loading={upkeep === 'reindex'}
                  disabled={upkeep !== null && upkeep !== 'reindex'}
                  disabledReason={upkeep ? t('common.working') : undefined}
                  onClick={() => void reindex()}
                  data-testid="memory-engine-reindex"
                >
                  {t('engine.upkeep.reindex')}
                </Button>
              </div>
              <div className={styles.upkeepRow}>
                <div className={styles.upkeepText}>
                  <span className={styles.upkeepLabel}>{t('engine.upkeep.tidy')}</span>
                  <span className={styles.upkeepHint}>{t('engine.upkeep.tidyHint')}</span>
                </div>
                <Button
                  size="sm"
                  loading={upkeep === 'tidy'}
                  disabled={upkeep !== null && upkeep !== 'tidy'}
                  disabledReason={upkeep ? t('common.working') : undefined}
                  onClick={() => void tidy()}
                  data-testid="memory-engine-tidy"
                >
                  {t('engine.upkeep.tidy')}
                </Button>
              </div>
            </div>
          </Section>
        </div>
      ) : engine.error ? (
        <ErrorNotice error={engine.error} fallback="error.load" onRetry={engine.reload} testId="memory-engine-error" />
      ) : (
        <LoadingBlock lines={2} rows={4} label={t('common.loading')} testId="memory-engine-loading" />
      )}
    </MemoryDialogFrame>
  );
}

/** The service reports provider and download failures in its own (English) words; this picks a plain sentence. */
export function failureSentence(raw: string, t: MemoryDialogT): string {
  const http = /\bHTTP (\d{3})\b/.exec(raw);
  if (http) {
    const status = Number(http[1]);
    return status === 401 || status === 403 ? t('engine.failure.auth') : t('engine.failure.http', { status });
  }
  if (/checksum/i.test(raw)) return t('engine.failure.checksum');
  if (/timed? ?out|timeout/i.test(raw)) return t('engine.failure.timeout');
  if (/unexpected response|invalid json|not valid json/i.test(raw)) return t('engine.failure.response');
  if (/fetch failed|ECONN|ENOTFOUND|EAI_AGAIN|network|socket|connect/i.test(raw)) return t('engine.failure.network');
  return t('engine.failure.other');
}

/** A failure in plain words, with the service's own text folded under it. */
function FailureText({ raw, lead, t }: { raw: string; lead?: string; t: MemoryDialogT }) {
  const plain = failureSentence(raw, t);
  return (
    <span className={styles.failure}>
      <span className={styles.failed}>{lead ? `${lead} · ${plain}` : plain}</span>
      {raw.trim() ? (
        <PaDisclosure label={t('engine.failure.raw')}>
          <span className={frame.caption}>{raw}</span>
        </PaDisclosure>
      ) : null}
    </span>
  );
}

function StatusBlock({ status, t }: { status: MemoryEngineStatus; t: MemoryDialogT }) {
  const labels = useMemoryLabels();
  const failures: Array<{ key: MemoryDialogKey; state: MemoryProviderState }> = [
    { key: 'engine.status.embeddingFailed', state: status.embedding },
    { key: 'engine.status.rerankerFailed', state: status.reranker },
    { key: 'engine.status.judgeFailed', state: status.judge },
  ];
  return (
    <Section title={t('engine.status.title')} testId="memory-engine-status">
      <div className={frame.group}>
        <div className={styles.level} data-testid="memory-engine-level">
          <span className={styles.levelName}>{t(`level.${status.level}` as MemoryDialogKey)}</span>
          <span className={styles.levelNote}>{t(`levelNote.${status.level}` as MemoryDialogKey)}</span>
        </div>
        <Fact label={t('engine.status.documents')}>{t('engine.status.documentsValue', { n: status.documents })}</Fact>
        {status.embedding.provider !== 'off' ? (
          <Fact label={t('engine.status.vectors')}>
            {t('engine.status.vectorsValue', { done: status.embedding.indexed, waiting: status.embedding.waiting })}
          </Fact>
        ) : null}
        <Fact label={t('engine.status.indexed')}>
          {status.lastIndexedAt !== null ? labels.when(status.lastIndexedAt) : t('engine.status.never')}
        </Fact>
        <Fact label={t('engine.status.speed')}>
          {status.recallLatencyMs && status.recallLatencyMs.samples > 0
            ? t('engine.status.speedValue', { p50: Math.round(status.recallLatencyMs.p50), p95: Math.round(status.recallLatencyMs.p95) })
            : t('engine.status.speedNone')}
        </Fact>
        {failures
          .filter((entry) => entry.state.error)
          .map((entry) => (
            <Fact key={entry.key} label={t(entry.key)}>
              <FailureText raw={entry.state.error ?? ''} t={t} />
            </Fact>
          ))}
      </div>
    </Section>
  );
}

/** The local models of one role, each with its size and licence and a way to get it onto this computer. */
function LocalModels({
  role,
  status,
  busyId,
  t,
  onAction,
}: {
  role: LocalRole;
  status: MemoryEngineStatus;
  busyId: string | null;
  t: MemoryDialogT;
  onAction(id: string, action: ModelAction): void;
}) {
  if (!status.localRuntime) {
    return (
      <p className={frame.caption} data-testid={`memory-engine-local-unavailable-${role}`}>
        {t('engine.local.unavailable')}
      </p>
    );
  }
  const models = status.localModels.filter((model) => model.role === role);
  if (models.length === 0) return <p className={frame.caption}>{t('engine.local.none')}</p>;
  const note = models.some((model) => model.state === 'ready')
    ? 'engine.local.readyNote'
    : role === 'embedding'
      ? 'engine.local.embeddingNote'
      : 'engine.local.rerankerNote';
  return (
    <>
      {models.map((model) => (
        <LocalModelRow key={model.id} model={model} busy={busyId === model.id} t={t} onAction={onAction} />
      ))}
      <p className={frame.caption}>{t(note)}</p>
    </>
  );
}

function sizeLabel(bytes: number, t: MemoryDialogT): string {
  if (bytes >= 1e9) return t('engine.local.sizeGb', { n: (bytes / 1e9).toFixed(1) });
  return t('engine.local.sizeMb', { n: Math.max(1, Math.round(bytes / 1e6)) });
}

function LocalModelRow({
  model,
  busy,
  t,
  onAction,
}: {
  model: MemoryLocalModel;
  busy: boolean;
  t: MemoryDialogT;
  onAction(id: string, action: ModelAction): void;
}) {
  const percent = Math.round(Math.min(1, Math.max(0, model.progress)) * 100);
  const action = (kind: ModelAction, label: string) => (
    <Button size="sm" loading={busy} onClick={() => onAction(model.id, kind)} data-testid={`memory-engine-model-${kind}-${model.id}`}>
      {label}
    </Button>
  );
  return (
    <div className={styles.model} data-state={model.state} data-testid={`memory-engine-model-${model.id}`}>
      <div className={styles.upkeepText}>
        <span className={styles.upkeepLabel}>{model.name}</span>
        <span className={styles.modelMeta}>{t('engine.local.meta', { size: sizeLabel(model.sizeBytes, t), license: model.license })}</span>
        {model.state === 'failed' ? (
          model.error ? (
            <FailureText raw={model.error} lead={t('engine.local.failed')} t={t} />
          ) : (
            <span className={styles.failed}>{t('engine.local.failed')}</span>
          )
        ) : null}
      </div>
      {model.state === 'ready' ? (
        <span className={styles.modelReady}>
          <Icon icon={Check} size="sm" />
          {t('engine.local.ready')}
        </span>
      ) : model.state === 'downloading' ? (
        <div className={styles.modelProgress}>
          <div className={styles.modelProgressBar}>
            <Progress value={percent} aria-label={t('engine.local.progress', { p: percent })} />
            <span className={styles.modelMeta}>{t('engine.local.progress', { p: percent })}</span>
          </div>
          {action('cancel', t('engine.local.cancel'))}
        </div>
      ) : (
        action('download', model.state === 'failed' ? t('engine.local.retry') : t('engine.local.download'))
      )}
    </div>
  );
}

function Choice<T extends string>({
  label,
  value,
  options,
  labelKey,
  testId,
  t,
  onChange,
}: {
  label: string;
  value: T;
  options: readonly T[];
  labelKey(value: T): MemoryDialogKey;
  testId: string;
  t: MemoryDialogT;
  onChange(value: T): void;
}) {
  return (
    <Segmented className="flex w-full" aria-label={label} value={value} onValueChange={(next) => onChange(next as T)} data-testid={testId}>
      {options.map((option) => (
        <SegmentedItem key={option} value={option} className="min-w-0 flex-1" data-testid={`${testId}-${option}`}>
          {t(labelKey(option))}
        </SegmentedItem>
      ))}
    </Segmented>
  );
}

function TextField({
  label,
  hint,
  value,
  placeholder,
  inputMode,
  testId,
  onChange,
}: {
  label: string;
  hint?: ReactNode;
  value: string;
  placeholder?: string;
  inputMode?: 'numeric' | 'decimal';
  testId: string;
  onChange(value: string): void;
}) {
  const id = useId();
  return (
    <Field label={label} htmlFor={id} labelVariant="form" hint={hint}>
      <Input
        id={id}
        value={value}
        placeholder={placeholder}
        inputMode={inputMode}
        autoComplete="off"
        spellCheck={false}
        maxLength={500}
        data-testid={testId}
        onChange={(event) => onChange(event.target.value)}
      />
    </Field>
  );
}

function KeyField({
  stored,
  draft,
  t,
  testId,
  onChange,
}: {
  stored: boolean;
  draft: KeyDraft;
  t: MemoryDialogT;
  testId: string;
  onChange(key: KeyDraft): void;
}) {
  const id = useId();
  const placeholder = draft.clear ? t('engine.key.willClear') : stored ? t('engine.key.stored') : t('engine.key.placeholder');
  return (
    <Field
      label={t('engine.field.key')}
      htmlFor={id}
      labelVariant="form"
      hint={
        stored ? (
          <Button variant="link" size="sm" className={styles.keyToggle} onClick={() => onChange({ value: '', clear: !draft.clear })}>
            {draft.clear ? t('engine.key.keep') : t('engine.key.clear')}
          </Button>
        ) : (
          t('engine.key.hint')
        )
      }
    >
      <Input
        id={id}
        type="password"
        value={draft.value}
        placeholder={placeholder}
        disabled={draft.clear}
        autoComplete="off"
        spellCheck={false}
        maxLength={500}
        data-testid={testId}
        onChange={(event) => onChange({ value: event.target.value, clear: false })}
      />
    </Field>
  );
}

function NumberRow({
  label,
  hint,
  value,
  min,
  max,
  step,
  testId,
  onChange,
}: {
  label: string;
  hint: string;
  value: string;
  min: number;
  max: number;
  step: number;
  testId: string;
  onChange(value: string): void;
}) {
  const id = useId();
  const hintId = useId();
  return (
    <div className={styles.numberRow}>
      <div className={styles.upkeepText}>
        <label htmlFor={id} className={styles.upkeepLabel}>
          {label}
        </label>
        <span id={hintId} className={styles.upkeepHint}>
          {hint}
        </span>
      </div>
      <Input
        id={id}
        type="number"
        value={value}
        min={min}
        max={max}
        step={step}
        aria-describedby={hintId}
        className={styles.number}
        data-testid={testId}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  );
}
