import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { RefreshCw, SearchX, Sparkles } from 'lucide-react';
import { TokenToSeaAccount } from '../TokenToSeaAccount';
import { tokenToSeaVideoAssets, tokenToSeaMediaAssets, EDITOR_FEATURED_MODELS, featuredEditorModel, type WorkspaceCollabContext } from '@open-design/contracts';
import { useT, useI18n } from '../../i18n';
import { readTokenToSeaStatus, tokenToSeaRequest } from '../../lib/tokentosea-account';
import {
  Button,
  Callout,
  Disclosure,
  Field,
  Icon,
  Input,
  SearchField,
  Segmented,
  SegmentedItem,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Textarea,
} from '../../fantay/ui';
import styles from './TokenToSeaServices.module.css';
import { ModelBrandIcon } from './ModelBrandIcon';
import { ToolPurposeIcon } from './ToolPurposeIcon';

interface Model {
  id: string; model: string; name?: string; displayName?: string; provider: string; modality?: string; executionKind?: string;
  toolCalling?: boolean; supportsTools?: boolean; priceVersion: string; priceSummary?: string; available?: boolean;
  brandLabel?: string; vendor?: string; supplyLabel?: string; summary?: string; description?: string;
  brand?: string | null; icon?: string | null; iconMono?: boolean;
  modelLimits?: { contextTokensLabel?: string; maxInputTokensLabel?: string; maxOutputTokens?: number };
  examples?: { id: string; path: string; mode: string; body: Record<string, unknown> }[];
}
interface Tool { id: string; publicId?: string; name: string; description?: string; category?: string; }
type ToolPage = { items?: Tool[]; tools?: Tool[]; total?: number } | Tool[];
interface Action { id: string; name: string; priceVersion: string; priceUsd: string; exampleInput?: Record<string, unknown>; requiresQuote?: boolean; inputSchema: { properties: Record<string, { type: string; description?: string; enum?: string[] }>; required?: string[] }; }
interface Result { id?: string; status?: string; deliveryState?: string; output?: unknown; errorCode?: string; chargedUsd?: string; }
async function payloadHash(input: Record<string, unknown>) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify({ input })));
  return [...new Uint8Array(bytes)].map(n => n.toString(16).padStart(2, '0')).join('');
}

/* Catalog modalities, folded into the few groups a person filters by. */
type ModelGroup = 'all' | 'chat' | 'image' | 'video' | 'audio' | 'other';
const MODEL_GROUPS: ModelGroup[] = ['all', 'chat', 'image', 'video', 'audio', 'other'];
function modelGroup(modality: string | undefined): Exclude<ModelGroup, 'all'> {
  if (!modality || modality === 'chat') return 'chat';
  if (modality === 'image') return 'image';
  if (modality === 'video') return 'video';
  if (['speech', 'asr', 'realtime', 'audio', 'music'].includes(modality)) return 'audio';
  return 'other';
}
const GROUP_LABEL: Record<ModelGroup, [string, string]> = {
  all: ['全部', 'All'], chat: ['对话', 'Chat'], image: ['图像', 'Image'], video: ['视频', 'Video'], audio: ['语音', 'Audio'], other: ['其他', 'Other'],
};
const MODALITY_LABEL: Record<string, [string, string]> = {
  chat: ['对话', 'Chat'], image: ['图像', 'Image'], video: ['视频', 'Video'], speech: ['语音合成', 'Speech'], asr: ['语音识别', 'Transcription'],
  realtime: ['实时语音', 'Realtime'], audio: ['音频', 'Audio'], music: ['音乐', 'Music'], embedding: ['向量', 'Embedding'], rerank: ['重排序', 'Rerank'],
  '3d': ['3D', '3D'], tool: ['工具', 'Tool'], system_one: ['判断模型', 'Judgment'],
};
function modelName(item: Model): string { return item.displayName ?? item.name ?? item.model; }
function monogram(text: string | undefined): string { return (text?.trim()[0] ?? '·').toUpperCase(); }

/**
 * TokenToSea models and tools on one account. `page` (default): the standalone services page with its
 * title and sign-in block. `embedded`: inside Settings ▸ 账户, which already shows the account and its
 * balance — no page title, no second sign-in, only the catalog and its refresh action.
 */
export function TokenToSeaServices({ active, variant = 'page', accountSignedIn, videoOnly = false, materialsOnly = false, initialPrompt = '', onVideoImport, onBusyChange, projectId, context }: {
  active: boolean; variant?: 'page' | 'embedded'; videoOnly?: boolean; materialsOnly?: boolean; initialPrompt?: string;
  accountSignedIn?: boolean;
  onVideoImport?: (runId: string, assetId: string) => Promise<void>;
  onBusyChange?: (busy: boolean) => void;
  projectId?: string;
  context?: WorkspaceCollabContext|null;
}) {
  const request = useCallback(<T,>(resource: string, body?: unknown, readSignal?: AbortSignal) =>
    tokenToSeaRequest<T>(resource, { body, projectId, context, readSignal }), [projectId, context]);
  const t = useT();
  const {locale}=useI18n();
  const zh = locale.startsWith('zh');
  const pick = (pair: [string, string]) => (zh ? pair[0] : pair[1]);
  const promptId = useId();
  const maxCostId = useId();
  // null until the status answers, so the embedded card never flashes "signed out" for a signed-in account.
  const [statusSignedIn, setStatusSignedIn] = useState<boolean | null>(null);
  const signedIn = accountSignedIn ?? statusSignedIn;
  const embedded = variant === 'embedded';
  const [revision, setRevision] = useState(0);
  const refresh = () => setRevision(value => value + 1);
  const toolsRevision = embedded ? 0 : revision;
  const [modelsLoading, setModelsLoading] = useState(false);
  const [toolsLoading, setToolsLoading] = useState(false);
  const [modelsFailed, setModelsFailed] = useState(false);
  const [failedToolsOffset, setFailedToolsOffset] = useState<number | null>(null);
  const toolsRequest = useRef<AbortController | null>(null);
  const [tab, setTab] = useState<'models' | 'tools'>('models');
  const [group, setGroup] = useState<ModelGroup>('all');
  const [models, setModels] = useState<Model[]>([]);
  const [tools, setTools] = useState<Tool[]>([]);
  const [toolsTotal, setToolsTotal] = useState(0);
  const [actions, setActions] = useState<Action[]>([]);
  const [selected, setSelected] = useState('');
  const [actionId, setActionId] = useState('');
  const [query, setQuery] = useState('');
  const [prompt, setPrompt] = useState(initialPrompt);
  useEffect(()=>{if(initialPrompt)setPrompt(initialPrompt);},[initialPrompt]);
  const [input, setInput] = useState('{}');
  const [maxCost, setMaxCost] = useState('0.10');
  const [balance, setBalance] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<Result | null>(null);
  const [notice, setNotice] = useState('');
  const [importing, setImporting] = useState(false);
  const [imported, setImported] = useState<string[]>([]);
  const model = models.find(item => item.id === selected);
  const tool = tools.find(item => item.id === selected);
  const action = actions.find(item => item.id === actionId);
  const videoAssets = materialsOnly ? tokenToSeaMediaAssets(result?.output) : tokenToSeaVideoAssets(result?.output);
  const generationOnly = videoOnly || materialsOnly;
  const waiting = ['running', 'pending', 'reserved', 'prepared'].includes(result?.status ?? '')
    || (generationOnly && result?.status === 'succeeded' && !videoAssets.length && ['pending', 'running', 'queued'].includes(result.deliveryState ?? ''));
  const pending = busy || waiting || importing;
  useEffect(() => { onBusyChange?.(pending); return () => onBusyChange?.(false); }, [pending, onBusyChange]);
  const scopedModels = useMemo(() => models.filter(item => !generationOnly || ((materialsOnly ? ['video','image','audio','speech','music'].includes(item.modality ?? '') : item.modality === 'video') && Boolean(item.executionKind))), [models, generationOnly, materialsOnly]);
  const groupCounts = useMemo(() => {
    const counts: Record<ModelGroup, number> = { all: scopedModels.length, chat: 0, image: 0, video: 0, audio: 0, other: 0 };
    for (const item of scopedModels) counts[modelGroup(item.modality)] += 1;
    return counts;
  }, [scopedModels]);
  const visibleGroups = MODEL_GROUPS.filter(key => key === 'all' || groupCounts[key] > 0);
  const modelSearchText = useMemo(() => {
    const map = new Map<Model, string>();
    for (const item of scopedModels) map.set(item, JSON.stringify(item).toLowerCase());
    return map;
  }, [scopedModels]);
  const toolSearchText = useMemo(() => {
    const map = new Map<Tool, string>();
    for (const item of tools) map.set(item, JSON.stringify(item).toLowerCase());
    return map;
  }, [tools]);
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (tab === 'models') {
      const byGroup = group === 'all' ? scopedModels : scopedModels.filter(item => modelGroup(item.modality) === group);
      return needle ? byGroup.filter(item => (modelSearchText.get(item) ?? '').includes(needle)) : byGroup;
    }
    return needle ? tools.filter(item => (toolSearchText.get(item) ?? '').includes(needle)) : tools;
  }, [scopedModels, tools, tab, query, group, modelSearchText, toolSearchText]);
  const toolsQuery = tab === 'tools' ? query : '';
  const loadTools = useCallback(async (offset = 0) => {
    toolsRequest.current?.abort();
    const controller = new AbortController();
    toolsRequest.current = controller;
    setFailedToolsOffset(null);
    setToolsLoading(true);
    try {
      const resource = offset || toolsQuery ? `tools?q=${encodeURIComponent(toolsQuery)}&offset=${offset}` : 'tools';
      const page = await request<ToolPage>(resource, undefined, controller.signal);
      const items = Array.isArray(page) ? page : page.items ?? page.tools;
      if (!Array.isArray(items)) throw new Error('Invalid TokenToSea tool catalog');
      if (controller.signal.aborted) return;
      setTools(previous => offset ? [...previous, ...items] : items);
      setToolsTotal(Array.isArray(page) ? items.length : page.total ?? items.length);
    } catch {
      if (!controller.signal.aborted) setFailedToolsOffset(offset);
    } finally {
      if (!controller.signal.aborted) setToolsLoading(false);
    }
  }, [request, toolsQuery]);

  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    const { signal } = controller;
    setModelsFailed(false);
    setModelsLoading(true);
    void (async () => {
      try {
        const connected = accountSignedIn ?? (await readTokenToSeaStatus(signal)).signedIn;
        if (signal.aborted) return;
        setStatusSignedIn(connected);
        if (!connected) {
          setModels([]);
          setTools([]);
          setToolsTotal(0);
          setBalance(null);
          return;
        }
        if (!embedded) {
          // The header balance is independent of the catalog.
          void request<{ availableUsd: string }>('wallet', undefined, signal)
            .then(wallet => {
              if (!signal.aborted) setBalance(typeof wallet?.availableUsd === 'string' ? wallet.availableUsd : null);
            })
            .catch(() => { if (!signal.aborted) setBalance(null); });
        }
        const catalog = await request<{ data: Model[] }>('models?includeOfficial=1', undefined, signal);
        if (!Array.isArray(catalog?.data)) throw new Error('Invalid TokenToSea model catalog');
        if (!signal.aborted) setModels(catalog.data);
      } catch {
        if (!signal.aborted) setModelsFailed(true);
      } finally {
        if (!signal.aborted) setModelsLoading(false);
      }
    })();
    return () => controller.abort();
  }, [active, accountSignedIn, embedded, request, revision]);

  useEffect(() => {
    if (!active || !signedIn || generationOnly) return;
    let timer: number | undefined;
    if (toolsQuery) {
      setToolsLoading(true);
      timer = window.setTimeout(() => void loadTools(), 250);
    } else {
      void loadTools();
    }
    return () => {
      window.clearTimeout(timer);
      toolsRequest.current?.abort();
    };
  }, [active, signedIn, generationOnly, loadTools, toolsRevision, toolsQuery]);
  useEffect(() => {
    if (!result?.id || !waiting) return;
    const timer = window.setTimeout(() => {
      const resource = tab === 'tools' ? `tools/runs/${result.id}` : model?.executionKind ? `official/runs/${result.id}` : `models/runs/${result.id}`;
      void request<Result>(resource).then(setResult).catch(e => setError(String(e)));
    }, 1800);
    return () => window.clearTimeout(timer);
  }, [result, tab, model, waiting]);
  async function select(id: string) {
    if (pending) return;
    setSelected(id); setResult(null); setError(''); setNotice(''); setActions([]); setActionId(''); setImported([]);
    if (tab === 'models') { const next = models.find(item => item.id === id); setInput(JSON.stringify(next?.examples?.find(example => example.mode === 'json')?.body ?? next?.examples?.[0]?.body ?? {}, null, 2)); }
    else {
      try { const next = await request<Action[]>(`tools/${encodeURIComponent(id)}/actions`); setActions(next); if (next[0]) { setActionId(next[0].id); setInput(JSON.stringify(next[0].exampleInput ?? {}, null, 2)); } }
      catch (e) { setError(String(e)); }
    }
  }
  async function run() {
    setBusy(true); setError(''); setResult(null); setNotice('');
    try {
      const params = JSON.parse(input) as Record<string, unknown>;
      if (!params || typeof params !== 'object' || Array.isArray(params)) throw new Error(t('tokentosea.services.inputNotObject'));
      const requestKey = crypto.randomUUID();
      if (tab === 'tools' && action) {
        const quote = action.requiresQuote ? await request<Record<string, unknown>>('tools/quote', { actionId: action.id, input: params }) : null;
        setResult(await request<Result>('tools/invoke', { actionId: action.id, input: params, requestKey, priceVersion: quote?.priceVersion ?? action.priceVersion, maxCostUsd: maxCost, ...(quote?.id ? { quoteId: quote.id } : {}) }));
      } else if (model) {
        params.model = model.executionKind ? model.model : model.id;
        if (prompt.trim()) {
          if (Array.isArray(params.messages) || model.modality === 'chat' || !model.modality) params.messages = [{ role: 'user', content: prompt }];
          else if (params.input && typeof params.input === 'object' && !Array.isArray(params.input)) params.input = { ...params.input, prompt };
          else if ('input' in params) params.input = prompt;
          else params.prompt = prompt;
        }
        if (model.executionKind) {
          const example = model.examples?.find(item => item.mode === 'json') ?? model.examples?.[0];
          if (!example || example.mode === 'ws') throw new Error(t('tokentosea.services.realtimeOnly'));
          if (example.mode === 'sse') params.stream = true; else if ('stream' in params) params.stream = false;
          const prepared = await request<Result>('official/prepare', { model: model.model, priceVersion: model.priceVersion, path: example.path, mode: example.mode, payloadHash: await payloadHash(params), requestKey, maxCostUsd: maxCost });
          setResult(await request<Result>(`official/runs/${prepared.id}/invoke`, { input: params }));
        } else {
          params.stream = false;
          setResult(await request<Result>('chat/completions', { ...params, requestKey, priceVersion: model.priceVersion, maxCostUsd: maxCost }));
        }
      }
      setNotice(t('tokentosea.services.submitted'));
    } catch (e) { setError(e instanceof Error ? e.message : t('tokentosea.services.runFailed')); }
    finally { setBusy(false); }
  }

  const balanceLabel = balance !== null ? t('tokentosea.services.balance', { amount: `$${balance}` }) : null;
  const refreshButton = (
    <Button variant="ghost" size="sm" onClick={refresh}>
      <Icon icon={RefreshCw} size="sm" />
      {t('tokentosea.services.refresh')}
    </Button>
  );
  const selectableActions = actions.filter(item => item.id);
  const featured = tab === 'models' && !query.trim()
    ? EDITOR_FEATURED_MODELS
      .filter(feature => (generationOnly ? feature.kind === 'video' : true))
      .map(feature => ({ feature, model: featuredEditorModel(feature, models) }))
      .filter((entry): entry is { feature: (typeof EDITOR_FEATURED_MODELS)[number]; model: Model } => Boolean(entry.model))
    : [];
  const modelMeta = (item: Model) => [item.brandLabel ?? item.provider, item.modality ? pick(MODALITY_LABEL[item.modality] ?? [item.modality, item.modality]) : pick(MODALITY_LABEL.chat!), item.supplyLabel].filter(Boolean).join(' · ');
  const loading = tab === 'models' ? modelsLoading : toolsLoading;
  const catalogError = signedIn && tab === 'tools'
    ? failedToolsOffset !== null && t('tokentosea.services.toolsFailed')
    : modelsFailed && t('tokentosea.services.loadFailed');
  const catalogRefreshLabel = catalogError ? t('fantayShell.sidebar.retry') : t('tokentosea.services.refresh');
  const refreshEmbeddedCatalog = () => {
    if (tab === 'models') refresh();
    else void loadTools(failedToolsOffset ?? 0);
  };
  const showSkeleton = loading && filtered.length === 0;
  const listEmpty = !loading && !catalogError && filtered.length === 0;

  const detail = model ? (
    <>
      <header className={styles.detailHead}>
        <span className={styles.badgeLg} aria-hidden="true"><ModelBrandIcon model={model} fallback={monogram(model.brandLabel ?? model.provider ?? modelName(model))} /></span>
        <div className={styles.detailHeadText}>
          <h2 className={styles.detailTitle}>{modelName(model)}</h2>
          <p className={styles.detailMeta}>{[model.brandLabel ?? model.provider, model.vendor && model.vendor !== model.brandLabel ? model.vendor : null, model.supplyLabel].filter(Boolean).join(' · ')}</p>
        </div>
      </header>
      {model.summary ?? model.description ? <p className={styles.summary}>{model.summary ?? model.description}</p> : null}
      <ul className={styles.specs} aria-label={zh ? '模型规格' : 'Model details'}>
        <li>{pick(MODALITY_LABEL[model.modality ?? 'chat'] ?? [model.modality ?? '', model.modality ?? ''])}</li>
        {model.modelLimits?.contextTokensLabel ? <li>{zh ? '上下文 ' : 'Context '}{model.modelLimits.contextTokensLabel}</li> : null}
        {model.modelLimits?.maxInputTokensLabel ? <li>{zh ? '输入 ' : 'Input '}{model.modelLimits.maxInputTokensLabel}</li> : null}
        {model.priceSummary ? <li className={styles.specPrice}>{model.priceSummary}</li> : null}
      </ul>
      {model.available === false ? <p role="status" className={styles.note}>{t('tokentosea.services.modelUnavailable')}</p> : null}
      <Field label={t('tokentosea.services.promptLabel')} htmlFor={promptId} labelVariant="form">
        <Textarea id={promptId} rows={4} value={prompt} onChange={e => setPrompt(e.target.value)} placeholder={t('tokentosea.services.promptPlaceholder')} className={styles.prompt} />
      </Field>
    </>
  ) : tool ? (
    <>
      <header className={styles.detailHead}>
        <span className={styles.badgeLg} aria-hidden="true"><ToolPurposeIcon tool={tool} size={28} /></span>
        <div className={styles.detailHeadText}>
          <h2 className={styles.detailTitle}>{tool.name}</h2>
          <p className={styles.detailMeta}>{zh ? '工具' : 'Tool'}</p>
        </div>
      </header>
      {tool.description ? <p className={styles.summary}>{tool.description}</p> : null}
      <Field label={t('tokentosea.services.actionLabel')} labelVariant="form">
        <Select
          disabled={pending}
          value={actionId}
          onValueChange={next => { setActionId(next); setInput(JSON.stringify(actions.find(item => item.id === next)?.exampleInput ?? {}, null, 2)); }}
        >
          <SelectTrigger aria-label={t('tokentosea.services.actionLabel')} className={styles.select}>
            <SelectValue placeholder={t('tokentosea.services.chooseAction')} />
          </SelectTrigger>
          <SelectContent>
            {selectableActions.map(item => <SelectItem key={item.id} value={item.id}>{item.name}</SelectItem>)}
          </SelectContent>
        </Select>
      </Field>
      <p className={styles.note}>{action ? t('tokentosea.services.actionPrice', { amount: `$${action.priceUsd}` }) : t('tokentosea.services.chooseAction')}</p>
    </>
  ) : selected ? (
    <header className={styles.detailHead}>
      <div className={styles.detailHeadText}><h2 className={styles.detailTitle}>{selected}</h2></div>
    </header>
  ) : null;

  return <section className={embedded ? styles.embedded : styles.page} data-testid="tokentosea-services" data-variant={variant}>
    {embedded ? null : (
      <header className={styles.header}>
        <div className={styles.headerText}>
          <h1 className={styles.title}>{t(videoOnly ? 'motion.timeline.generate' : 'tokentosea.services.title')}</h1>
          <p className={styles.lede}>{t(videoOnly ? 'motion.timeline.tokenToSeaHint' : 'tokentosea.services.body')}</p>
        </div>
        <div className={styles.account}>
          {balanceLabel ? <span className={styles.balance}>{balanceLabel}</span> : null}
          {refreshButton}
        </div>
      </header>
    )}
    {signedIn === null ? (
      modelsFailed ? (embedded ? refreshButton : null) : (
        <div className={styles.catalog} aria-busy="true"><div className={styles.skeletonBlock} /></div>
      )
    ) : !signedIn ? (
      embedded ? <p className={styles.signedOut}>{t('fantay.account.servicesSignedOut')}</p> : active ? (
        <div className={styles.signIn}>
          <h2 className={styles.signInTitle}>{t('tokentosea.services.connectTitle')}</h2>
          <p className={styles.signInBody}>{t('tokentosea.services.connectBody')}</p>
          <TokenToSeaAccount variant="inline" onSignedIn={refresh} />
        </div>
      ) : null
    ) : (
      <div className={styles.catalog}>
        <div className={styles.controls}>
          {!generationOnly ? <Segmented
            aria-label={t('fantay.account.servicesTitle')}
            size="sm"
            value={tab}
            onValueChange={next => {
              if (pending || (next !== 'models' && next !== 'tools')) return;
              setTab(next); setSelected('');
            }}
            className={styles.tabs}
          >
            <SegmentedItem value="models" disabled={pending}>{t('tokentosea.services.tabModels')}{models.length ? <span className={styles.count}>{scopedModels.length}</span> : null}</SegmentedItem>
            <SegmentedItem value="tools" disabled={pending}>{t('tokentosea.services.tabTools')}{toolsTotal ? <span className={styles.count}>{toolsTotal}</span> : null}</SegmentedItem>
          </Segmented> : null}
          <SearchField
            className={styles.search}
            aria-label={t('tokentosea.services.search')}
            placeholder={t('tokentosea.services.search')}
            value={query}
            onChange={e => setQuery(e.target.value)}
          />
          {embedded ? (
            <Button variant="bare" size="icon-sm" aria-label={catalogRefreshLabel} title={catalogRefreshLabel} disabled={loading} onClick={refreshEmbeddedCatalog} className={styles.refresh} data-loading={loading || undefined}>
              <Icon icon={RefreshCw} size="sm" />
            </Button>
          ) : null}
        </div>
        {catalogError ? <Callout tone="error" role="alert" className={styles.error}>{catalogError}</Callout> : null}
        {tab === 'models' && visibleGroups.length > 2 ? (
          <div className={styles.filters} role="group" aria-label={zh ? '按类型筛选' : 'Filter by type'}>
            {visibleGroups.map(key => (
              <button key={key} type="button" className={styles.filter} aria-pressed={group === key} onClick={() => setGroup(key)}>
                {pick(GROUP_LABEL[key])}<span className={styles.filterCount}>{groupCounts[key]}</span>
              </button>
            ))}
          </div>
        ) : null}
        {featured.length > 0 ? (
          <div className={styles.featuredModels} role="group" aria-label={zh ? '新版剪辑模型' : 'New editor models'}>
            <span className={styles.featuredLabel}><Icon icon={Sparkles} size="sm" />{zh ? '推荐' : 'Featured'}</span>
            {featured.map(({ feature, model: available }) => (
              <button key={feature.id} type="button" className={styles.featuredChip} aria-pressed={selected === available.id} disabled={pending} onClick={() => void select(available.id)} title={modelName(available)}>
                {feature.name}
              </button>
            ))}
          </div>
        ) : null}
        <div className={styles.split}>
          <div className={styles.list}>
            {showSkeleton ? (
              <div className={styles.rows} aria-busy="true" aria-label={t('fantay.ui.loading')}>
                {Array.from({ length: 7 }, (_, index) => (
                  <div key={index} className={styles.skeletonRow} style={{ animationDelay: `${index * 70}ms` }}>
                    <span className={styles.skeletonBadge} />
                    <span className={styles.skeletonLines}><span /><span /></span>
                  </div>
                ))}
              </div>
            ) : listEmpty ? (
              <div className={styles.listEmpty}>
                <Icon icon={SearchX} size="md" />
                <span>{query.trim() ? (zh ? '没有匹配的结果' : 'No matches') : (zh ? '暂无可用项目' : 'Nothing here yet')}</span>
              </div>
            ) : (
              <div className={styles.rows}>
                {filtered.map(entry => {
                  const item = tab === 'models' ? { model: entry as Model } : { tool: entry as Tool };
                  const name = item.model ? modelName(item.model) : item.tool!.name;
                  return (
                    <button
                      type="button"
                      disabled={pending}
                      key={entry.id}
                      className={styles.serviceRow}
                      data-service-id={entry.id}
                      aria-pressed={entry.id === selected}
                      onClick={() => void select(entry.id)}
                    >
                      <span className={styles.badge} aria-hidden="true">{item.model ? <ModelBrandIcon model={item.model} fallback={monogram(item.model.brandLabel ?? item.model.provider ?? name)} /> : <ToolPurposeIcon tool={item.tool!} />}</span>
                      <span className={styles.rowText}>
                        <strong className={styles.serviceName}>{name}</strong>
                        <span className={styles.serviceMeta}>{item.model ? modelMeta(item.model) : item.tool!.description}</span>
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
            {tab === 'tools' && tools.length < toolsTotal ? (
              <Button size="sm" variant="bare" className={styles.loadMore} disabled={toolsLoading} onClick={() => void loadTools(tools.length)}>{t('tokentosea.services.loadMoreTools')}</Button>
            ) : null}
          </div>
          <div className={styles.detail}>
            {selected ? <>
              {detail}
              <Disclosure
                key={tab}
                defaultOpen={tab === 'tools'}
                label={tab === 'tools' ? t('tokentosea.services.toolParams') : t('tokentosea.services.advancedParams')}
                className={styles.params}
              >
                <Textarea className={styles.parameters} aria-label={t('tokentosea.services.paramsAria')} rows={8} value={input} onChange={e => setInput(e.target.value)} spellCheck={false} />
                <p className={`${styles.note} ${styles.paramsHint}`}>{t('tokentosea.services.paramsHint')}</p>
              </Disclosure>
              <div className={styles.run}>
                <Field label={t('tokentosea.services.maxCost')} htmlFor={maxCostId} labelVariant="form" className={styles.maxCost}>
                  <Input id={maxCostId} type="number" min="0" max="100" step="0.01" value={maxCost} onChange={e => setMaxCost(e.target.value)} />
                </Field>
                <Button variant="primary" disabled={pending || model?.available === false || tab === 'tools' && !action} onClick={() => void run()}>
                  {pending ? t('tokentosea.services.running') : t('tokentosea.services.run')}
                </Button>
              </div>
              {notice ? <p role="status" className={styles.notice}>{notice}</p> : null}
              {result ? (
                <div className={styles.result}>
                  <div className={styles.resultHead}>
                    <strong>{result.status ? t('tokentosea.services.status', { status: result.status }) : t('tokentosea.services.result')}</strong>
                    {result.chargedUsd ? <span>{t('tokentosea.services.charged', { amount: `$${result.chargedUsd}` })}</span> : null}
                  </div>
                  {generationOnly ? <div>
                    {videoAssets.map(assetId => <Button key={assetId} disabled={pending || imported.includes(assetId)} onClick={() => {
                      if (!result.id || !onVideoImport) return;
                      setImporting(true); setError('');
                      void onVideoImport(result.id, assetId).then(() => setImported(items => [...items, assetId]))
                        .catch(e => setError(e instanceof Error ? e.message : String(e))).finally(() => setImporting(false));
                    }}>{t(imported.includes(assetId) ? 'motion.timeline.imported' : 'motion.timeline.importGenerated')}</Button>)}
                    {result.errorCode ? <p role="alert">{result.errorCode}</p> : null}
                  </div> : <pre className={styles.resultBody}>{JSON.stringify(result.output ?? result, null, 2)}</pre>}
                </div>
              ) : null}
            </> : (
              <div className={styles.placeholder}>
                <span className={styles.placeholderIcon} aria-hidden="true"><Icon icon={Sparkles} size="md" /></span>
                <strong className={styles.placeholderTitle}>{zh ? '选择一个模型或工具' : 'Pick a model or tool'}</strong>
                <span className={styles.empty}>{zh ? '查看能力与价格，并直接试用。' : 'See what it does and what it costs, then try it.'}</span>
              </div>
            )}
          </div>
        </div>
      </div>
    )}
    {!signedIn && catalogError ? <Callout tone="error" role="alert" className={styles.error}>{catalogError}</Callout> : null}
    {error ? <Callout tone="error" role="alert" className={styles.error}>{error}</Callout> : null}
  </section>;
}
