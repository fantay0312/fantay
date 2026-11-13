import { useEffect, useRef, useState } from 'react';
import type { JianyingDraftEntry, JianyingDraftResult, JianyingEnvironment, JianyingInspection, JianyingOperation, JianyingValidation, MovieDocument, MovieVideoSource, WorkspaceCollabContext } from '@open-design/contracts';
import { Button, Callout, Checkbox, Input, Modal, ModalTitle, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Textarea } from '../../fantay/ui';
import { useI18n } from '../../i18n';
import { jianyingRequest } from '../../providers/jianying';
import styles from './JianyingDraftDialog.module.css';

type EditKind = 'set_text' | 'set_volume' | 'set_speed' | 'trim' | 'split' | 'move' | 'delete' | 'transform' | 'replace_media' | 'add_text' | 'add_media';
export function JianyingDraftDialog({ open, mode, onClose, projectId, context, document, sources }: {
  open: boolean; mode: 'create' | 'edit'; onClose(): void; projectId: string; context?: WorkspaceCollabContext | null;
  document: MovieDocument; sources: MovieVideoSource[];
}) {
  const { t } = useI18n();
  const [environment, setEnvironment] = useState<JianyingEnvironment | null>(null);
  const [drafts, setDrafts] = useState<JianyingDraftEntry[]>([]), [draftId, setDraftId] = useState('');
  const [inspection, setInspection] = useState<JianyingInspection | null>(null), [segmentId, setSegmentId] = useState('');
  const [name, setName] = useState(document.title), [kind, setKind] = useState<EditKind>('set_text');
  const [text, setText] = useState(''), [value, setValue] = useState('1'), [start, setStart] = useState('0'), [media, setMedia] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [allowUnverified, setAllowUnverified] = useState(false);
  const [result, setResult] = useState<JianyingDraftResult | null>(null), [installed, setInstalled] = useState(false);
  const generation = useRef(0);
  const call = <T,>(route: string, body?: unknown, local = false, signal?: AbortSignal) => jianyingRequest<T>(projectId, context, route, body, local, signal);
  useEffect(() => {
    const token = ++generation.current, abort = new AbortController();
    if (!open) return () => abort.abort();
    setError(''); setResult(null); setInspection(null); setDraftId(''); setName(mode === 'create' ? document.title : `${document.title} · ${t('jianying.copy')}`); setInstalled(false); setBusy(false); setAllowUnverified(false);
    void Promise.all([call<JianyingEnvironment>('status', undefined, false, abort.signal), mode === 'edit' ? call<{ drafts: JianyingDraftEntry[] }>('drafts?local=true', undefined, true, abort.signal) : Promise.resolve({ drafts: [] })]).then(([env, list]) => { if (token === generation.current && !abort.signal.aborted) { setEnvironment(env); setDrafts(list.drafts); } }).catch(cause => { if (!abort.signal.aborted && token === generation.current) setError(String(cause.message)); });
    return () => { abort.abort(); generation.current++; };
  }, [open, mode, projectId, context?.workspaceId, context?.workspaceMemberId]);
  const refresh = async () => { setError(''); try { setEnvironment(await call<JianyingEnvironment>('status')); } catch (cause) { setError((cause as Error).message); } };
  const selectDraft = async (id: string) => {
    setDraftId(id); setInspection(null); setSegmentId(''); setResult(null); setError(''); setBusy(true);
    const token = generation.current;
    try {
      const response = await call<{ inspection: JianyingInspection; validation: JianyingValidation }>(`inspect?draftId=${encodeURIComponent(id)}`, undefined, true);
      if (token !== generation.current) return;
      setInspection(response.inspection);
      const first = response.inspection.tracks.find(track => track.type === 'text')?.segments[0] ?? response.inspection.tracks.flatMap(track => track.segments)[0];
      setSegmentId(first?.id ?? ''); setText(first?.text ?? ''); setKind(first?.text !== undefined ? 'set_text' : 'set_volume'); setValue(String((first?.volume ?? 1) * 100));
      if (!response.validation.valid) setError(response.validation.errors.map(e => e.message).join('; '));
    } catch (cause) { if (token === generation.current) setError((cause as Error).message); }
    finally { if (token === generation.current) setBusy(false); }
  };
  function operation(): JianyingOperation {
    const numeric = Number(value), at = Number(start);
    if (!Number.isFinite(numeric) || !Number.isFinite(at)) throw new Error(t('jianying.invalidNumber'));
    if (kind === 'add_text') return { op: 'add', clip: { type: 'text', text, start: at, duration: numeric, subtitle: true, track: inspection?.tracks.filter(track => track.type === 'text').length ?? 0 } };
    if (kind === 'add_media') {
      const source = sources.find(s => s.path === media);
      if (!source) throw new Error(t('jianying.chooseMedia'));
      return { op: 'add', clip: { type: source.kind ?? 'video', path: source.path, start: at, duration: numeric, track: inspection?.tracks.filter(track => track.type === (source.kind === 'image' ? 'video' : source.kind ?? 'video')).length ?? 0 } };
    }
    if (!segmentId) throw new Error(t('jianying.chooseSegment'));
    if (kind === 'set_text') return { op: kind, segmentId, text };
    if (kind === 'set_volume') return { op: kind, segmentId, volume: numeric / 100 };
    if (kind === 'set_speed') return { op: kind, segmentId, speed: numeric };
    if (kind === 'trim') return { op: kind, segmentId, sourceStart: at, duration: numeric };
    if (kind === 'split') return { op: kind, segmentId, at };
    if (kind === 'move') return { op: kind, segmentId, start: at };
    if (kind === 'delete') return { op: kind, segmentId };
    if (kind === 'replace_media') { if (!media) throw new Error(t('jianying.chooseMedia')); return { op: kind, segmentId, path: media }; }
    return { op: 'transform', segmentId, transform: { scaleX: numeric, scaleY: numeric } };
  }
  const submit = async () => {
    setBusy(true); setError(''); setInstalled(false); const token = generation.current;
    try {
      const created = mode === 'create'
        ? await call<JianyingDraftResult>('create', { source: 'timeline', name, expectedRevision: document.revision, allowUnverified })
        : await call<JianyingDraftResult>('edit', { draftId, name, operations: [operation()] }, true);
      if (token === generation.current) {
        setResult(created);
        if (mode === 'edit') {
          setDrafts(items => [created.draft, ...items.filter(item => item.id !== created.draft.id)]);
          setDraftId(created.draft.id); setInspection(created.inspection);
          const candidates = created.inspection.tracks.flatMap(track => track.segments);
          if (!candidates.some(segment => segment.id === segmentId)) setSegmentId(candidates[0]?.id ?? '');
        }
      }
    } catch (cause) { if (token === generation.current) setError((cause as Error).message); }
    finally { if (token === generation.current) setBusy(false); }
  };
  const install = async () => {
    if (!result) return; setBusy(true); setError(''); const token = generation.current;
    try { await call('install', { draftId: result.draft.id, name }); if (token === generation.current) setInstalled(true); }
    catch (cause) { if (token === generation.current) setError((cause as Error).message); }
    finally { if (token === generation.current) setBusy(false); }
  };
  const needsConsent = Boolean(environment?.application.installed && environment.compatibility !== 'verified');
  const adds = kind === 'add_text' || kind === 'add_media';
  const operations: EditKind[] = ['set_text', 'set_volume', 'set_speed', 'trim', 'split', 'move', 'delete', 'transform', 'replace_media', 'add_text', 'add_media'];
  return <Modal open={open} onClose={() => { if (!busy) onClose(); }} showClose={!busy} size="lg" aria-describedby="jianying-description">
    <ModalTitle>{t(mode === 'create' ? 'jianying.create' : 'jianying.edit')}</ModalTitle>
    <div className={styles.body} aria-busy={busy}>
      <p id="jianying-description" className={styles.hint}>{t('jianying.preserve')}</p>
      <div className={styles.environment}>
        <div><strong>{environment?.application.installed ? `Jianying ${environment.application.version}` : t('jianying.notInstalled')}</strong><span>{environment ? t(environment.compatibility === 'verified' ? 'jianying.verified' : 'jianying.unverified') : t('jianying.detecting')}</span></div>
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => void refresh()}>{t('jianying.detect')}</Button>
      </div>
      {environment?.application.installed && !environment.capabilities.editEncrypted ? <p className={styles.hint}>{t('jianying.plaintextOnly')}</p> : null}
      <label className={styles.field}>{t('jianying.name')}<Input value={name} onChange={e => setName(e.target.value)} disabled={busy} /></label>
      {mode === 'edit' ? <>
        <label className={styles.field}>{t('jianying.source')}<Select value={draftId} onValueChange={id => void selectDraft(id)} disabled={busy}><SelectTrigger aria-label={t('jianying.source')}><SelectValue placeholder={t('jianying.chooseDraft')} /></SelectTrigger><SelectContent>{drafts.map(draft => <SelectItem key={draft.id} value={draft.id}>{draft.name} · {t(draft.origin === 'local' ? 'jianying.local' : 'jianying.project')}</SelectItem>)}</SelectContent></Select></label>
        {!drafts.length && environment ? <p className={styles.hint}>{t('jianying.empty')}</p> : null}
        {inspection ? <>
          <div className={styles.summary}>{inspection.tracks.length} {t('jianying.tracks')} · {inspection.duration.toFixed(2)} s · {inspection.encoding === 'native' ? t('jianying.encrypted') : t('jianying.plaintext')}</div>
          <label className={styles.field}>{t('jianying.operation')}<Select value={kind} onValueChange={v => { setKind(v as EditKind); setValue(v === 'set_volume' ? '100' : v === 'trim' || v === 'add_media' || v === 'add_text' ? '2' : '1'); }} disabled={busy}><SelectTrigger aria-label={t('jianying.operation')}><SelectValue /></SelectTrigger><SelectContent>{operations.map(op => <SelectItem key={op} value={op}>{t(`jianying.op.${op}`)}</SelectItem>)}</SelectContent></Select></label>
          {!adds ? <label className={styles.field}>{t('jianying.segment')}<Select value={segmentId} onValueChange={id => { setSegmentId(id); setText(inspection.tracks.flatMap(track => track.segments).find(s => s.id === id)?.text ?? ''); }} disabled={busy}><SelectTrigger aria-label={t('jianying.segment')}><SelectValue /></SelectTrigger><SelectContent>{inspection.tracks.flatMap(track => track.segments.map((segment, index) => <SelectItem key={segment.id} value={segment.id}>{track.name ?? track.type} · {index + 1} · {segment.start.toFixed(2)} s{segment.text ? ` · ${segment.text.slice(0, 24)}` : ''}</SelectItem>))}</SelectContent></Select></label> : null}
          {kind === 'set_text' || kind === 'add_text' ? <label className={styles.field}>{t('jianying.text')}<Textarea value={text} onChange={e => setText(e.target.value)} rows={3} disabled={busy} /></label> : null}
          {kind === 'replace_media' || kind === 'add_media' ? <label className={styles.field}>{t('jianying.media')}<Select value={media} onValueChange={setMedia} disabled={busy}><SelectTrigger aria-label={t('jianying.media')}><SelectValue placeholder={t('jianying.chooseMedia')} /></SelectTrigger><SelectContent>{sources.map(source => <SelectItem key={source.assetId} value={source.path}>{source.label}</SelectItem>)}</SelectContent></Select></label> : null}
          {['set_volume', 'set_speed', 'trim', 'transform', 'add_text', 'add_media'].includes(kind) ? <label className={styles.field}>{t(kind === 'set_volume' ? 'jianying.volume' : kind === 'set_speed' ? 'jianying.speed' : kind === 'transform' ? 'jianying.scale' : 'jianying.duration')}<Input type="number" step="any" value={value} onChange={e => setValue(e.target.value)} disabled={busy} /></label> : null}
          {['trim', 'split', 'move', 'add_text', 'add_media'].includes(kind) ? <label className={styles.field}>{t(kind === 'trim' ? 'jianying.sourceStart' : 'jianying.at')}<Input type="number" min="0" step="any" value={start} onChange={e => setStart(e.target.value)} disabled={busy} /></label> : null}
        </> : null}
      </> : needsConsent ? <label className={styles.consent}><Checkbox checked={allowUnverified} onChange={e => setAllowUnverified(e.target.checked)} disabled={busy} />{t('jianying.allowUnverified')}</label> : null}
      {error ? <Callout tone="error" role="alert">{error}</Callout> : null}
      {result ? <div className={styles.result} role="status"><strong>{t('jianying.completed')}</strong><span>{result.draft.path}</span><p>{t('jianying.preserve')}</p>{result.warnings.map((warning, i) => <p key={i} className={styles.hint}>{warning === 'DEFAULT_TEXT_STYLES' ? t('jianying.textStyles') : warning}</p>)}
        {installed ? <p>{t('jianying.installed')}</p> : <><Button disabled={busy || !environment?.application.installed} onClick={() => void install()}>{t('jianying.install')}</Button><p className={styles.hint}>{t('jianying.quitFirst')}</p></>}
      </div> : null}
      <div className={styles.actions}><Button variant="ghost" disabled={busy} onClick={onClose}>{t('jianying.close')}</Button><Button variant="primary" disabled={busy || !environment || !name.trim() || (mode === 'create' ? needsConsent && !allowUnverified : !inspection || (!segmentId && !adds))} onClick={() => void submit()}>{busy ? t('jianying.working') : t(mode === 'create' ? 'jianying.create' : 'jianying.saveCopy')}</Button></div>
    </div>
  </Modal>;
}
