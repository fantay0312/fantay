// SPDX-License-Identifier: AGPL-3.0-only
// 文风与模型 ▸ 声音 of the profile editor (STAGE2 5.8): the speech service that reads this character's replies aloud,
// its voice and the language. Only services set up in Settings can be picked; a saved one that is no longer listed or
// no longer set up stays visible with 未配置. Picking never generates audio: audio is made only on 朗读, under 自动朗读,
// or on 试听 here, which reads one sample line with the voice as picked (saved or not).
// Provider and model labels come from the media catalogue and are not translated; language names neither.
import { useEffect, useId, useState } from 'react';
import { Square, Volume2 } from 'lucide-react';
import { SOUL_LIMITS, speechSampleText } from '@open-design/contracts/soul';

import { useI18n, useT } from '../../../i18n';
import { Button, Icon, Input, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../ui';
import { runFantayCommand } from '../../shell/commands';
import { usePa } from '../pa-context';
import type { PaSpeechModel, PaVoice } from '../pa-types';
import modalStyles from '../PaModals.module.css';
import { useSoulSpeechStatus, useSoulVoiceSample } from './soul-voice';
import { SoulTag } from './SoulPrimitives';
import styles from './SoulProfileModal.module.css';

const L = SOUL_LIMITS;
/** Radix items cannot carry an empty value: the row for "no voice" and for the service default voice / auto language. */
const NONE = '__none__';
/** Language names are written in their own language and not translated. */
const LANGUAGES: ReadonlyArray<{ id: string; name: string }> = [
  { id: 'zh', name: '中文' },
  { id: 'en', name: 'English' },
  { id: 'ja', name: '日本語' },
];

type VoiceList = { model: string; phase: 'loading' } | { model: string; phase: 'ready'; voices: Array<{ id: string; name: string }> } | { model: string; phase: 'failed' };

export interface SoulVoiceFieldProps {
  value: PaVoice | null;
  onChange(next: PaVoice | null): void;
  /** The character's display name: the sample line of 试听 says it. */
  name: string;
}

export function SoulVoiceField({ value, onChange, name }: SoulVoiceFieldProps) {
  const t = useT();
  const { locale } = useI18n();
  const { data } = usePa();
  const status = useSoulSpeechStatus();
  const sample = useSoulVoiceSample();
  const uid = useId();
  const ids = { model: `${uid}-model`, voice: `${uid}-voice`, language: `${uid}-language` };
  const models = status?.models ?? [];
  const current: PaSpeechModel | null = value ? (models.find((model) => model.id === value.model) ?? null) : null;
  // A saved model the status no longer lists is shown as not set up (once the status is known).
  const missing = value && status && !current ? value.model : null;
  const kind: PaSpeechModel['voices'] = current?.voices ?? 'free';
  const unavailable = status !== null && !status.available;
  // A character without a voice of its own is read with the status's default voice (TokenToSea's, when signed in).
  const fallback = status?.default ?? null;
  const fallbackLabel = fallback ? (models.find((model) => model.id === fallback.model)?.label ?? fallback.model) : null;

  const [list, setList] = useState<VoiceList | null>(null);
  const listModel = value && kind === 'list' ? value.model : null;
  useEffect(() => {
    if (!listModel) return;
    let alive = true;
    setList({ model: listModel, phase: 'loading' });
    data.actions
      .speechVoices(listModel)
      .then((answer) => {
        if (alive) setList({ model: listModel, phase: 'ready', voices: Array.isArray(answer?.voices) ? answer.voices : [] });
      })
      .catch(() => {
        if (alive) setList({ model: listModel, phase: 'failed' });
      });
    return () => {
      alive = false;
    };
  }, [listModel, data.actions]);

  const pickModel = (model: string) => {
    if (model === NONE) {
      onChange(null);
      return;
    }
    // A voice id belongs to its service: a new service starts on its default voice.
    onChange({ model, voice: value?.model === model ? value.voice : '', language: value?.language ?? '' });
  };
  const patch = (next: Partial<PaVoice>) => {
    if (value) onChange({ ...value, ...next });
  };

  const voices = list && list.model === value?.model ? list : null;
  const freeVoice = kind === 'free' || voices?.phase === 'failed';
  const voiceOver = (value?.voice.length ?? 0) > L.voiceId;
  const listed = voices?.phase === 'ready' ? voices.voices : [];
  const savedVoiceMissing = value && value.voice !== '' && voices?.phase === 'ready' && !listed.some((voice) => voice.id === value.voice);
  const savedLanguageOther = value && value.language !== '' && !LANGUAGES.some((language) => language.id === value.language);
  // 试听 needs a service that is set up; the sample is spoken in the voice's language, else in the app's. With no
  // voice picked, it plays the default one this character would be read with.
  const sampled = value ?? fallback;
  const canSample = (value ? Boolean(current?.configured) : fallback !== null) && !voiceOver;
  const playSample = () => {
    if (sampled) sample.toggle(sampled, speechSampleText(sampled.language || locale, name));
  };
  const sampleRow = (
    <div className={modalStyles.row}>
      <div className={modalStyles.rowText}>
        <div className={modalStyles.rowLabel}>{t('pa.soul.editor.voice.sample')}</div>
        <div className={modalStyles.rowHint}>{t('pa.soul.editor.voice.sampleHint')}</div>
      </div>
      <div className={modalStyles.rowControl}>
        <Button
          variant="secondary"
          size="sm"
          data-testid="pa-profile-voice-sample"
          disabled={!canSample}
          loading={sample.phase === 'generating'}
          onClick={playSample}
        >
          <Icon icon={sample.phase === 'playing' ? Square : Volume2} size="sm" />
          {t(sample.phase === 'playing' ? 'pa.soul.editor.voice.sampleStop' : 'pa.soul.editor.voice.samplePlay')}
        </Button>
      </div>
    </div>
  );

  const optionLabel = (label: string, unconfigured: boolean) => (
    <span className={styles.voiceOption}>
      <span className={styles.voiceOptionText}>{label}</span>
      {unconfigured ? <SoulTag tone="outline">{t('pa.soul.editor.voice.unconfigured')}</SoulTag> : null}
    </span>
  );

  return (
    <div className="flex min-w-0 flex-col gap-3" data-testid="pa-profile-voice">
      <h4 className={styles.groupTitle}>{t('pa.soul.editor.voice.title')}</h4>
      <div className={modalStyles.group}>
        <div className={modalStyles.row}>
          <div className={modalStyles.rowText}>
            <label htmlFor={ids.model} className={modalStyles.rowLabel}>
              {t('pa.soul.editor.voice.model')}
            </label>
          </div>
          <div className={modalStyles.rowControl}>
            <Select value={value?.model ?? NONE} onValueChange={pickModel}>
              <SelectTrigger id={ids.model} className={styles.voiceSelect} data-testid="pa-profile-voice-model">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>
                  {fallbackLabel ? t('pa.soul.editor.voice.defaultOf', { service: fallbackLabel }) : t('pa.soul.editor.voice.none')}
                </SelectItem>
                {models.map((model) => (
                  <SelectItem key={model.id} value={model.id} disabled={!model.configured && model.id !== value?.model}>
                    {optionLabel(model.label, !model.configured)}
                  </SelectItem>
                ))}
                {value && !current ? <SelectItem value={value.model}>{optionLabel(value.model, missing !== null)}</SelectItem> : null}
              </SelectContent>
            </Select>
          </div>
        </div>

        {value ? (
          <>
            <div className={modalStyles.row}>
              <div className={modalStyles.rowText}>
                <label htmlFor={ids.voice} className={modalStyles.rowLabel}>
                  {t(freeVoice ? 'pa.soul.editor.voice.voiceId' : 'pa.soul.editor.voice.voice')}
                </label>
                {freeVoice ? (
                  <div className={voiceOver ? modalStyles.rowError : modalStyles.rowHint}>
                    {voiceOver
                      ? t('pa.soul.editor.counter', { n: value.voice.length.toLocaleString(), max: L.voiceId.toLocaleString() })
                      : voices?.phase === 'failed'
                        ? t('pa.soul.editor.voice.loadFailed')
                        : t('pa.soul.editor.voice.voiceIdHint')}
                  </div>
                ) : null}
              </div>
              <div className={modalStyles.rowControl}>
                {freeVoice ? (
                  <Input
                    id={ids.voice}
                    value={value.voice}
                    autoComplete="off"
                    spellCheck={false}
                    placeholder={t('pa.soul.editor.voice.voiceDefault')}
                    className={styles.voiceSelect}
                    aria-invalid={voiceOver || undefined}
                    data-testid="pa-profile-voice-id"
                    onChange={(event) => patch({ voice: event.target.value })}
                  />
                ) : (
                  <Select value={value.voice || NONE} disabled={voices?.phase !== 'ready'} onValueChange={(voice) => patch({ voice: voice === NONE ? '' : voice })}>
                    <SelectTrigger id={ids.voice} className={styles.voiceSelect} data-testid="pa-profile-voice-id">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={NONE}>{t('pa.soul.editor.voice.voiceDefault')}</SelectItem>
                      {listed.map((voice) => (
                        <SelectItem key={voice.id} value={voice.id}>
                          {voice.name}
                        </SelectItem>
                      ))}
                      {savedVoiceMissing ? <SelectItem value={value.voice}>{value.voice}</SelectItem> : null}
                    </SelectContent>
                  </Select>
                )}
              </div>
            </div>
            <div className={modalStyles.row}>
              <div className={modalStyles.rowText}>
                <label htmlFor={ids.language} className={modalStyles.rowLabel}>
                  {t('pa.soul.editor.voice.language')}
                </label>
              </div>
              <div className={modalStyles.rowControl}>
                <Select value={value.language || NONE} onValueChange={(language) => patch({ language: language === NONE ? '' : language })}>
                  <SelectTrigger id={ids.language} className={styles.voiceSelect}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NONE}>{t('pa.soul.editor.voice.languageAuto')}</SelectItem>
                    {LANGUAGES.map((language) => (
                      <SelectItem key={language.id} value={language.id}>
                        {language.name}
                      </SelectItem>
                    ))}
                    {savedLanguageOther ? <SelectItem value={value.language}>{value.language}</SelectItem> : null}
                  </SelectContent>
                </Select>
              </div>
            </div>
            {sampleRow}
          </>
        ) : fallback ? (
          sampleRow
        ) : null}
        {unavailable ? (
          <div className={modalStyles.row} data-testid="pa-profile-voice-unavailable">
            <div className={modalStyles.rowText}>
              <div className={modalStyles.rowCopy}>{t('pa.soul.manage.chat.voiceNoProvider')}</div>
            </div>
            <div className={modalStyles.rowControl}>
              <Button variant="secondary" size="sm" onClick={() => runFantayCommand('fantay.openSettings')}>
                {t('pa.soul.manage.chat.voiceOpenSettings')}
              </Button>
            </div>
          </div>
        ) : null}
      </div>
      <p className={styles.caption}>
        {t('pa.soul.editor.voice.hint')}
        {fallback ? ` ${t('pa.soul.editor.voice.defaultHint')}` : ''}
      </p>
    </div>
  );
}

/** A saved voice whose voice id is over its limit holds 保存 (the daemon would refuse it). */
export function voiceOverLimit(voice: PaVoice | null | undefined): boolean {
  return Boolean(voice && (voice.voice.length > L.voiceId || voice.language.length > L.voiceLanguage));
}
