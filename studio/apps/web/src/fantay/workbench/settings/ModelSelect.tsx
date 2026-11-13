/*
 * SPDX-License-Identifier: AGPL-3.0-only
 * Fantay 工作台 — one TokenToSea model picker (text or image). 自动 follows the account's first usable
 * model and shows which one that is; a model the account no longer offers stays visible as unavailable.
 * Derived from dsh-media-desk client/modelpick.jsx (https://github.com/woniuniuniu/dsh-media-desk),
 * MIT, Copyright (c) 2026 woniuniuniu.
 */
import { useMemo } from 'react';
import type { WorkbenchModelOption } from '@open-design/contracts';

import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectSeparator, SelectTrigger, SelectValue } from '../../ui/select';
import { useL } from '../lang';
import styles from './Settings.module.css';

const AUTO = '__auto__';

export interface ModelSelectProps {
  kind: 'text' | 'image';
  /** '' = 自动. */
  value: string;
  /** Label of the model 自动 resolves to right now. */
  autoLabel: string | null;
  /** null while loading. */
  models: WorkbenchModelOption[] | null;
  error: string | null;
  signedIn: boolean;
  onChange(value: string): void;
}

export function ModelSelect({ kind, value, autoLabel, models, error, signedIn, onChange }: ModelSelectProps) {
  const L = useL();
  const groups = useMemo(() => {
    const map = new Map<string, WorkbenchModelOption[]>();
    for (const model of models ?? []) {
      const key = model.provider?.trim() || '';
      map.set(key, [...(map.get(key) ?? []), model]);
    }
    return [...map.entries()];
  }, [models]);
  const known = (models ?? []).some(model => model.id === value);
  const autoText = autoLabel ? L(`自动（${autoLabel}）`, `Auto (${autoLabel})`) : L('自动', 'Auto');
  const status = !signedIn
    ? L('登录后可选', 'Sign in to choose')
    : error
      ? L('模型列表读取失败', 'Could not load models')
      : models === null
        ? L('正在读取…', 'Loading…')
        : models.length === 0
          ? kind === 'image'
            ? L('账户里没有可用的生图模型', 'No image models on this account')
            : L('账户里没有可用的文字模型', 'No text models on this account')
          : null;
  return (
    <div className={styles.modelSelect}>
      <Select value={value || AUTO} onValueChange={next => onChange(next === AUTO ? '' : next)}>
        <SelectTrigger className={styles.modelTrigger} aria-label={kind === 'image' ? L('生图模型', 'Image model') : L('文字模型', 'Text model')}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={AUTO}>{autoText}</SelectItem>
          {value && !known ? <SelectItem value={value}>{L(`${value}（不可用）`, `${value} (unavailable)`)}</SelectItem> : null}
          {groups.length ? <SelectSeparator /> : null}
          {groups.map(([provider, list]) => (
            <SelectGroup key={provider || 'default'}>
              {provider ? <SelectLabel>{provider}</SelectLabel> : null}
              {list.map(model => <SelectItem key={model.id} value={model.id}>{model.name || model.id}</SelectItem>)}
            </SelectGroup>
          ))}
        </SelectContent>
      </Select>
      {status ? <span className={styles.modelStatus} title={error ?? undefined}>{status}</span> : null}
    </div>
  );
}
