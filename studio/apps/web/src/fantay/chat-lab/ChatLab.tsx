// fx-governance-allow-raw: a dev-only motion bench linked from nowhere; its speed range input has no primitive
'use client';
/*
 * SPDX-License-Identifier: AGPL-3.0-only
 * Fantay-original: /fantay-ui/chat-lab — a live motion bench for the chat turn. It replays
 * scripted event streams through the production AssistantMessage so streaming reveal,
 * thinking rows, shell folds and completion states can be judged in motion. Linked from nowhere.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ChatMessage, PersistedAgentEvent } from '@open-design/contracts';

import type { ProjectFile } from '@open-design/contracts';
import { AssistantMessage } from '../../components/AssistantMessage';
import { ChatComposer } from '../../components/ChatComposer';
import { UserMessageImpl } from '../../components/ChatPane';
import { chatSeam } from '../../components/chat/ChatRoot';
import { useT } from '../../i18n';
import { LAB_SCENARIOS, type LabScenario } from './scenarios';
import styles from './ChatLab.module.css';

interface LabTurn {
  user: ChatMessage;
  assistant: ChatMessage;
  streaming: boolean;
}

const LAB_FILES: ProjectFile[] = ([
  ['index.html', 'html', 'text/html'],
  ['styles.css', 'code', 'text/css'],
  ['hero.png', 'image', 'image/png'],
  ['notes.md', 'text', 'text/markdown'],
] satisfies [string, ProjectFile['kind'], string][]).map(([name, kind, mime]) => ({ name, path: name, type: 'file', size: 1200, mtime: 0, kind, mime }));

function stampEvent(event: PersistedAgentEvent, now: number): PersistedAgentEvent {
  const e = { ...event } as PersistedAgentEvent & { startedAt?: number; completedAt?: number; at?: number };
  if (e.kind === 'tool_use') e.startedAt = now;
  if (e.kind === 'tool_result') e.completedAt = now;
  if (e.kind === 'thinking_tokens') e.at = now;
  return e;
}

function newTurn(scenario: LabScenario, index: number): LabTurn {
  const now = Date.now();
  return {
    user: { id: `lab-user-${index}`, role: 'user', content: scenario.prompt, createdAt: now },
    assistant: {
      id: `lab-assistant-${index}`,
      role: 'assistant',
      content: '',
      agentId: scenario.agentId,
      agentName: scenario.agentName,
      events: [],
      createdAt: now,
      startedAt: now,
      runId: `lab-run-${index}`,
      runStatus: 'running',
    },
    streaming: true,
  };
}

export function ChatLab() {
  const t = useT();
  const [turns, setTurns] = useState<LabTurn[]>([]);
  const [speed, setSpeed] = useState(1);
  const [asHistory, setAsHistory] = useState(false);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const counter = useRef(0);

  const clearTimers = useCallback(() => {
    for (const id of timers.current) clearTimeout(id);
    timers.current = [];
  }, []);
  useEffect(() => clearTimers, [clearTimers]);

  const play = useCallback((scenario: LabScenario) => {
    const index = counter.current++;
    const turn = newTurn(scenario, index);
    if (asHistory) {
      // Settled transcript, as after a refresh: every event already there, nothing streaming.
      const start = Date.now() - 60_000;
      let content = '';
      const events: PersistedAgentEvent[] = [];
      let status: LabTurn['assistant']['runStatus'] = 'succeeded';
      let lastAt = 0;
      for (const step of scenario.steps) {
        lastAt = step.at;
        if ('end' in step) { status = step.end; continue; }
        const event = stampEvent(step.event, start + step.at);
        if (event.kind === 'text') content += event.text;
        events.push(event);
      }
      const settled: LabTurn = {
        ...turn,
        streaming: false,
        assistant: { ...turn.assistant, content, events, runStatus: status, startedAt: start, endedAt: start + lastAt },
      };
      setTurns((prev) => [...prev.map((p) => ({ ...p, streaming: false })), settled]);
      return;
    }
    setTurns((prev) => [...prev.map((p) => ({ ...p, streaming: false })), turn]);
    for (const step of scenario.steps) {
      const id = setTimeout(() => {
        setTurns((prev) => prev.map((p) => {
          if (p.assistant.id !== turn.assistant.id) return p;
          const now = Date.now();
          if ('end' in step) {
            return {
              ...p,
              streaming: false,
              assistant: { ...p.assistant, runStatus: step.end, endedAt: now },
            };
          }
          const event = stampEvent(step.event, now);
          const content = event.kind === 'text' ? p.assistant.content + event.text : p.assistant.content;
          return { ...p, assistant: { ...p.assistant, content, events: [...(p.assistant.events ?? []), event] } };
        }));
      }, step.at / speed);
      timers.current.push(id);
    }
  }, [asHistory, speed]);

  const reset = useCallback(() => {
    clearTimers();
    setTurns([]);
  }, [clearTimers]);

  const lastIndex = turns.length - 1;
  const log = useMemo(() => turns.flatMap((turn, i) => [
    <UserMessageImpl key={turn.user.id} message={turn.user} projectId={null} t={t} />,
    <AssistantMessage
      key={turn.assistant.id}
      message={turn.assistant}
      streaming={turn.streaming}
      showRole
      isLast={i === lastIndex}
      isLastTurn={i === lastIndex}
      conversationId="lab"
      projectId="lab"
    />,
  ]), [lastIndex, t, turns]);

  return (
    <div className={styles.page}>
      <aside className={styles.controls}>
        <h1 className={styles.title}>Chat motion lab</h1>
        <p className={styles.hint}>Replays scripted turns through the production AssistantMessage.</p>
        <div className={styles.group}>
          {LAB_SCENARIOS.map((s) => (
            <button key={s.id} type="button" className={styles.btn} onClick={() => play(s)} data-testid={`lab-play-${s.id}`}>
              {s.label}
            </button>
          ))}
        </div>
        <label className={styles.toggle}>
          <input type="checkbox" checked={asHistory} onChange={(e) => setAsHistory(e.target.checked)} />
          以历史方式载入(已落定)
        </label>
        <label className={styles.speed}>
          速度 {speed}×
          <input type="range" min={0.25} max={3} step={0.25} value={speed} onChange={(e) => setSpeed(Number(e.target.value))} />
        </label>
        <button type="button" className={styles.btn} onClick={reset}>清空</button>
      </aside>
      <main className={styles.stage}>
        <div {...chatSeam('pane')}>
          <div className="chat-log-wrap">
            <div className="chat-log-viewport">
              <div className="chat-log" data-testid="lab-chat-log">{log}</div>
            </div>
          </div>
          {/* The production composer, so its height glide and @ / slash popover exits can be
              judged here too. Sends go nowhere; the slash list reads the daemon's skills. */}
          <div className="chat-composer-slot">
            <ChatComposer
              projectId="lab"
              projectFiles={LAB_FILES}
              streaming={false}
              onEnsureProject={async () => 'lab'}
              onSend={() => undefined}
              onStop={() => undefined}
              onOpenMcpSettings={() => undefined}
              skills={[]}
            />
          </div>
        </div>
      </main>
    </div>
  );
}
