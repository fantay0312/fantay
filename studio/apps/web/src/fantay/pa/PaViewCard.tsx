// SPDX-License-Identifier: AGPL-3.0-only
import { useRef } from 'react';
import { QUESTION_CSS, WIDGET_CSS, ViewUi, WidgetCard } from 'deep-view/react';
import type { PaTask, PaTaskCardAnswer, PaViewAnswer, PaViewCard as Card } from '@open-design/contracts';
import { useI18n } from '../../i18n';
import { toast } from '../ui';
import { usePa } from './pa-context';
import { PaMarkdown } from './PaMarkdown';
import styles from './PaViewCard.module.css';

const zh: Record<string, string> = {
  Send: '提交', Submit: '提交', Cancel: '取消', Confirm: '确认', Continue: '继续', Copy: '复制', Selected: '已选中',
  'Copy table': '复制表格', 'Download CSV': '下载 CSV', 'Show table': '查看表格', 'Show chart': '查看图表',
  'No data': '暂无数据', 'Choose options': '选择选项', 'Select an option': '选择一个选项',
};

export function PaViewStyles() {
  return <style>{QUESTION_CSS + WIDGET_CSS}</style>;
}

export function PaViewCard({ card, answer, busy, onSubmit }: {
  card: Card; answer?: PaViewAnswer | undefined; busy?: boolean | undefined;
  onSubmit?: ((action: string, values: Record<string, unknown>) => void) | undefined;
}) {
  const { locale } = useI18n();
  return (
    <div className={styles.card}>
      <ViewUi.Provider value={{
        Markdown: PaMarkdown,
        t: (key, params) => (locale.startsWith('zh') ? zh[key] ?? key : key)
          .replace(/\{(\w+)\}/g, (match, name: string) => String(params?.[name] ?? match)),
      }}>
        <WidgetCard title={card.title} view={card.view} settled={card.interactive && !onSubmit} answer={answer ?? null}
          {...(busy === undefined ? {} : { busy })} {...(onSubmit ? { onSubmit } : {})} />
      </ViewUi.Provider>
    </div>
  );
}

export function PaPendingViewCard({ task }: { task: PaTask }) {
  const { data } = usePa();
  const sending = useRef(false);
  const pending = task.pendingView;
  const question = task.channelQuestion;
  if (!pending && !question) return null;
  const card: Card = pending ?? {
    title: question!.prompt, summary: '', interactive: true,
    view: { type: 'options', id: 'answer', options: question!.options.map(label => ({ label })), multi: question!.multiple },
  };
  const submit = (action: string, values: Record<string, unknown>) => {
    if (sending.current) return;
    const input: PaTaskCardAnswer = pending
      ? { kind: 'view', attemptId: pending.attemptId, action, values }
      : {
          kind: 'question', attemptId: question!.attemptId,
          choices: Array.isArray(values.selected) ? values.selected
            .filter((label): label is string => typeof label === 'string')
            .map(label => question!.options.indexOf(label) + 1).filter(index => index > 0) : [],
        };
    sending.current = true;
    void data.actions.answerTaskCard(task.id, input)
      .catch((error: unknown) => toast({ tone: 'danger', title: error instanceof Error ? error.message : String(error) }))
      .finally(() => { sending.current = false; });
  };
  return <PaViewCard card={card} busy={data.pending.has(`card:${task.id}`)} onSubmit={submit} />;
}
