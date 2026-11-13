/*
 * SPDX-License-Identifier: AGPL-3.0-only
 * Fantay 工作台 — schedule one item: a date and time (with quick slots) and the platform it goes
 * to, through `schedule_item`. Also clears an existing schedule.
 * Derived from dsh-media-desk (https://github.com/woniuniuniu/dsh-media-desk), MIT, Copyright (c) 2026 woniuniuniu.
 */
import { useEffect, useId, useState } from 'react';
import type { WorkbenchItem } from '@open-design/contracts';
import { Button, Chip, Field, Input } from '../../ui';
import { useL, useWorkbenchLang } from '../lang';
import { displayItem, fmtWhen, platformChoices, platformName, toLocalInput } from '../shared/format';
import { workbench } from '../store';
import { useLastDefined } from './data';
import { Choices, WbModal, WbSection } from './WbModal';

interface Slot { key: string; label: string; date: Date }

function at(base: Date, dayOffset: number, hours: number): Date {
  const d = new Date(base);
  d.setDate(d.getDate() + dayOffset);
  d.setHours(hours, 0, 0, 0);
  return d;
}

/** Tomorrow 20:00 unless a day was given (then that day at 20:00). */
export function defaultScheduleTime(day?: Date | null): Date {
  if (day) return at(day, 0, 20);
  return at(new Date(), 1, 20);
}

export interface ScheduleDialogProps {
  item: WorkbenchItem | null;
  open: boolean;
  onClose(): void;
  /** Pre-select this day (keeps the item's time of day, else 20:00). */
  day?: Date | null;
}

export function ScheduleDialog({ item: liveItem, open, onClose, day }: ScheduleDialogProps) {
  const item = useLastDefined(liveItem);
  const L = useL();
  const lang = useWorkbenchLang();
  const ids = { when: useId() };
  const [when, setWhen] = useState('');
  const [platform, setPlatform] = useState('');
  const [busy, setBusy] = useState<'save' | 'clear' | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !item) return;
    let initial: Date;
    if (day) {
      initial = new Date(day);
      const previous = item.scheduledAt ? new Date(item.scheduledAt) : null;
      initial.setHours(previous?.getHours() ?? 20, previous?.getMinutes() ?? 0, 0, 0);
    } else {
      initial = item.scheduledAt ? new Date(item.scheduledAt) : defaultScheduleTime();
    }
    setWhen(toLocalInput(initial.toISOString()));
    setPlatform(item.platform ?? '');
    setBusy(null);
    setError(null);
    // reset only when the dialog opens for an item
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, item?.id, day?.getTime()]);

  const now = new Date();
  const saturday = (6 - now.getDay() + 7) % 7 || 7;
  const slots: Slot[] = [
    ...(now.getHours() < 19 ? [{ key: 'tonight', label: L('今晚 20:00', 'Tonight 20:00'), date: at(now, 0, 20) }] : []),
    { key: 'am', label: L('明早 08:00', 'Tomorrow 08:00'), date: at(now, 1, 8) },
    { key: 'noon', label: L('明天 12:00', 'Tomorrow 12:00'), date: at(now, 1, 12) },
    { key: 'pm', label: L('明晚 20:00', 'Tomorrow 20:00'), date: at(now, 1, 20) },
    { key: 'sat', label: L('周六 10:00', 'Saturday 10:00'), date: at(now, saturday, 10) },
  ];

  const save = async () => {
    if (!item || busy) return;
    const date = new Date(when);
    if (!when || Number.isNaN(date.getTime())) {
      setError(L('选一个发布时间', 'Pick a publish time'));
      return;
    }
    setBusy('save');
    const response = await workbench.ops(
      // platform only when it changed; '' clears it
      [{ op: 'schedule_item', id: item.id, scheduledAt: date.toISOString(), ...(platform !== (item.platform ?? '') ? { platform: platform || null } : {}) }],
      { label: L('修改排期', 'Reschedule') },
    );
    setBusy(null);
    if (response && !response.errors.length) onClose();
  };

  const clear = async () => {
    if (!item || busy) return;
    setBusy('clear');
    const response = await workbench.ops([{ op: 'schedule_item', id: item.id, scheduledAt: null }], { label: L('取消排期', 'Unschedule') });
    setBusy(null);
    if (response && !response.errors.length) onClose();
  };

  const title = item ? displayItem(item).title : '';
  const options = [
    { value: '', label: L('暂不指定', 'Not set') },
    ...platformChoices(lang).map((p) => ({ value: p, label: platformName(p, lang) })),
  ];

  return (
    <WbModal
      open={open}
      onClose={onClose}
      title={item?.scheduledAt ? L('修改排期', 'Reschedule') : L('排期', 'Schedule')}
      lede={item ? `${title}${item.scheduledAt ? ` · ${L('现在', 'now')} ${fmtWhen(item.scheduledAt, lang)}` : ''}` : undefined}
      onSubmit={() => void save()}
      footer={
        <>
          {item?.scheduledAt ? (
            <Button variant="bare" loading={busy === 'clear'} onClick={() => void clear()}>
              {L('取消排期', 'Unschedule')}
            </Button>
          ) : null}
          <span style={{ flex: 1 }} />
          <Button variant="ghost" onClick={onClose}>
            {L('取消', 'Cancel')}
          </Button>
          <Button type="submit" variant="primary" loading={busy === 'save'}>
            {L('排期', 'Schedule')}
          </Button>
        </>
      }
    >
      <WbSection title={L('发布时间', 'Publish time')}>
        <Field htmlFor={ids.when} error={error}>
          <Input
            id={ids.when}
            type="datetime-local"
            value={when}
            required
            onChange={(event) => {
              setWhen(event.target.value);
              setError(null);
            }}
          />
        </Field>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {slots.map((slot) => (
            <Chip
              key={slot.key}
              size="sm"
              variant="suggestion"
              on={toLocalInput(slot.date.toISOString()) === when}
              onClick={() => {
                setWhen(toLocalInput(slot.date.toISOString()));
                setError(null);
              }}
            >
              {slot.label}
            </Chip>
          ))}
        </div>
      </WbSection>
      <WbSection title={L('发布平台', 'Platform')} hint={L('排期不会替你发出，到时去平台发布。', 'Fantay never posts for you; publish on the platform.')}>
        <Choices label={L('发布平台', 'Platform')} value={platform} options={options} onChange={setPlatform} />
      </WbSection>
    </WbModal>
  );
}
