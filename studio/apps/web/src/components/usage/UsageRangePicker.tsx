/* SPDX-License-Identifier: AGPL-3.0-only */
/* Range presets (今天 … 90 天) plus a one-month calendar for any custom range, after Cursor's usage page. */
import { useState } from 'react';
import { CalendarDays, ChevronDown, ChevronLeft, ChevronRight } from 'lucide-react';
import { Button, Icon, IconButton, Popover, PopoverContent, PopoverTrigger, Segmented, SegmentedItem } from '../../fantay/ui';
import {
  MAX_RANGE_DAYS, daySpan, daysInMonth, formatDay, formatRange, monthName, monthOf, presetLabel, presetRange, shiftMonth, weekday,
  type RangePreset, type UsageRange,
} from './usage-format';
import styles from './UsageRangePicker.module.css';

const FULL_PRESETS: RangePreset[] = ['today', '7d', '30d', 'mtd', 'last-month', '90d'];
const COMPACT_PRESETS: RangePreset[] = ['today', '7d', '30d'];

export function UsageRangePicker({ value, onChange, today, zh, compact = false }: {
  value: UsageRange;
  onChange: (range: UsageRange) => void;
  today: string;
  zh: boolean;
  compact?: boolean;
}) {
  const presets = compact ? COMPACT_PRESETS : FULL_PRESETS;
  return (
    <div className={styles.picker} data-compact={compact || undefined}>
      {compact ? null : <RangeCalendar value={value} onApply={onChange} today={today} zh={zh} />}
      <Segmented
        className={styles.presets}
        size={compact ? 'sm' : 'md'}
        value={value.preset}
        onValueChange={preset => onChange(presetRange(preset as RangePreset, today))}
        aria-label={zh ? '统计范围' : 'Date range'}
      >
        {presets.map(preset => (
          <SegmentedItem key={preset} value={preset}>{presetLabel(preset, zh)}</SegmentedItem>
        ))}
      </Segmented>
    </div>
  );
}

function RangeCalendar({ value, onApply, today, zh }: {
  value: UsageRange;
  onApply: (range: UsageRange) => void;
  today: string;
  zh: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [start, setStart] = useState(value.from);
  const [end, setEnd] = useState<string | null>(value.to);
  const [hover, setHover] = useState<string | null>(null);
  const [month, setMonth] = useState(monthOf(value.to));

  const reset = () => {
    setStart(value.from);
    setEnd(value.to);
    setHover(null);
    setMonth(monthOf(value.to));
  };
  const pick = (day: string) => {
    if (end !== null || day < start) {
      setStart(day);
      setEnd(null);
    } else {
      setEnd(day);
    }
  };

  const previewEnd = end ?? (hover && hover >= start ? hover : start);
  const span = daySpan(start, previewEnd);
  const tooLong = span > MAX_RANGE_DAYS;
  const canApply = end !== null && !tooLong;
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

  const offset = weekday(`${month}-01`);
  const cells: Array<string | null> = [
    ...Array.from({ length: offset }, () => null),
    ...Array.from({ length: daysInMonth(month) }, (_, index) => `${month}-${String(index + 1).padStart(2, '0')}`),
  ];
  const weekdays = zh ? ['一', '二', '三', '四', '五', '六', '日'] : ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];

  return (
    <Popover
      open={open}
      onOpenChange={next => {
        if (next) reset();
        setOpen(next);
      }}
    >
      <PopoverTrigger asChild>
        <Button
          className={styles.trigger}
          data-custom={value.preset === 'custom' ? '' : undefined}
          aria-label={zh ? `自定义范围：${formatRange(value.from, value.to, zh, today)}` : `Custom range: ${formatRange(value.from, value.to, zh, today)}`}
        >
          <Icon icon={CalendarDays} size="sm" />
          <span className={styles.triggerLabel}>{formatRange(value.from, value.to, zh, today)}</span>
          <Icon icon={ChevronDown} size="xs" className={styles.chevron} />
        </Button>
      </PopoverTrigger>
      <PopoverContent width="auto" align="start" className={styles.popover} aria-label={zh ? '选择日期范围' : 'Choose a date range'}>
        <div className={styles.head}>
          <strong className={styles.month}>{monthName(month, zh, true)}</strong>
          <span className={styles.zone} title={zh ? '按这个时区划分日期' : 'Days are counted in this time zone'}>{timeZone}</span>
          <span className={styles.nav}>
            <IconButton size="sm" aria-label={zh ? '上个月' : 'Previous month'} onClick={() => setMonth(shiftMonth(month, -1))}>
              <Icon icon={ChevronLeft} size="sm" />
            </IconButton>
            <IconButton
              size="sm"
              aria-label={zh ? '下个月' : 'Next month'}
              disabled={month >= monthOf(today)}
              onClick={() => setMonth(shiftMonth(month, 1))}
            >
              <Icon icon={ChevronRight} size="sm" />
            </IconButton>
          </span>
        </div>
        <div className={styles.grid} role="group" aria-label={monthName(month, zh, true)} onPointerLeave={() => setHover(null)}>
          {weekdays.map(name => <span key={name} className={styles.weekday} aria-hidden="true">{name}</span>)}
          {cells.map((day, index) => {
            if (!day) return <span key={`blank-${index}`} aria-hidden="true" />;
            const future = day > today;
            const edge = day === start || day === previewEnd;
            const inside = day > start && day < previewEnd;
            return (
              <button
                key={day}
                type="button"
                className={styles.day}
                data-edge={edge ? '' : undefined}
                data-inside={inside ? '' : undefined}
                data-start={day === start ? '' : undefined}
                data-end={day === previewEnd ? '' : undefined}
                data-today={day === today ? '' : undefined}
                disabled={future}
                aria-pressed={edge || inside}
                aria-label={formatDay(day, zh, today)}
                onClick={() => pick(day)}
                onPointerEnter={() => setHover(day)}
              >
                {Number(day.slice(8))}
              </button>
            );
          })}
        </div>
        <div className={styles.foot}>
          <span className={styles.selection} role="status">
            {tooLong
              ? (zh ? `最多 ${MAX_RANGE_DAYS} 天` : `At most ${MAX_RANGE_DAYS} days`)
              : end === null
                ? (zh ? '选择结束日期' : 'Pick an end date')
                : (zh ? `${span} 天` : `${span} day${span === 1 ? '' : 's'}`)}
          </span>
          <Button size="sm" onClick={() => setOpen(false)}>{zh ? '取消' : 'Cancel'}</Button>
          <Button
            size="sm"
            variant="primary"
            disabled={!canApply}
            onClick={() => {
              if (!end) return;
              onApply({ preset: 'custom', from: start, to: end });
              setOpen(false);
            }}
          >
            {zh ? '应用' : 'Apply'}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
