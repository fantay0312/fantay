// SPDX-License-Identifier: AGPL-3.0-only
import type { ChatRunStatusResponse, Project } from '@open-design/contracts';
import { describe, expect, it } from 'vitest';

import {
  buildTimeline, showsInFollowing, sortTimeline, timelineFollowTarget, type ProjectRunHistory,
} from '../../../src/fantay/plugins/builtin/project-timeline/timeline-model';
import {
  readTimelineNotes, saveTimelineNote,
} from '../../../src/fantay/plugins/builtin/project-timeline/timeline-storage';

const project: Project = { id: 'a', name: 'Design', createdAt: 10, updatedAt: 120, designSystemId: null, skillId: null };

function run(id: string, fields: Partial<ChatRunStatusResponse> = {}): ChatRunStatusResponse {
  return {
    id, status: 'succeeded', projectId: 'a', conversationId: 'c', assistantMessageId: null,
    agentId: 'codex', createdAt: 20, updatedAt: 50, ...fields,
  };
}

describe('project timeline', () => {
  it('orders actual milestones and shows only authorized project entries with safe project-relative files', () => {
    const histories = new Map<string, ProjectRunHistory>([['a', {
      awaitingInputProjectIds: ['a'],
      runs: [
        run('one', { terminalAt: 25, endedWithUnfinishedWork: true }),
        run('two', { createdAt: 22, updatedAt: 60, terminalAt: 45, artifactPaths: ['design/cover.png', '../other', 'design/cover.png'] }),
        run('hidden', { projectId: 'b' }),
      ],
    }]]);
    const entries = buildTimeline([project], histories, [
      { id: 'one', projectId: 'a', text: 'Feedback', at: 30 },
      { id: 'hidden', projectId: 'b', text: 'Private update', at: 60 },
    ]);
    expect(sortTimeline(entries, 'oldest').map(entry => [entry.kind, entry.at])).toEqual([
      ['created', 10], ['incomplete', 20], ['awaiting_input', 22], ['note', 30],
    ]);
    expect(entries.find(entry => entry.id === 'run:two')?.files).toEqual(['design/cover.png']);
  });

  it('promotes the same reply on completion in progress order and keeps its original place in time order', () => {
    const notes = [{ id: 'newer', projectId: null, text: 'Update', at: 80 }];
    const before = buildTimeline([project], new Map([['a', {
      awaitingInputProjectIds: [],
      runs: [run('pending', { status: 'running' }), run('previous', { createdAt: 40, terminalAt: 60 })],
    }]]), notes);
    expect(sortTimeline(before, 'progress').map(entry => entry.id)).toEqual([
      'run:previous', 'note:newer', 'run:pending', 'project:a',
    ]);
    const after = buildTimeline([project], new Map([['a', {
      awaitingInputProjectIds: [],
      runs: [run('pending', { terminalAt: 70, updatedAt: 300 }), run('previous', { createdAt: 40, terminalAt: 60 })],
    }]]), notes);
    expect(sortTimeline(after, 'newest').map(entry => entry.id)).toEqual([
      'note:newer', 'run:previous', 'run:pending', 'project:a',
    ]);
    expect(sortTimeline(after, 'progress').slice(0, 2).map(entry => [entry.id, entry.completedAt])).toEqual([
      ['run:pending', 70], ['run:previous', 60],
    ]);
  });

  it('shows future replies in a followed conversation and all entries of a followed project', () => {
    const entries = buildTimeline([project], new Map([['a', {
      awaitingInputProjectIds: [],
      runs: [run('one'), run('two'), run('other', { conversationId: 'd' })],
    }]]), [{ id: 'standalone', projectId: null, text: 'Update', at: 100 }]);
    const first = entries.find(entry => entry.id === 'run:one')!;
    const conversation = new Set([timelineFollowTarget(first).key]);
    expect(entries.filter(entry => showsInFollowing(entry, conversation)).map(entry => entry.id))
      .toEqual(['run:one', 'run:two']);
    expect(entries.filter(entry => showsInFollowing(entry, new Set(['project:a', 'note:standalone'])))).toEqual(entries);
  });

  it('retains separate local updates by principal and rejects a note over 140 Unicode characters', () => {
    const items = new Map<string, string>();
    const storage: Storage = {
      get length() { return items.size; },
      key: (index: number) => [...items.keys()][index] ?? null,
      getItem: (key: string) => items.get(key) ?? null,
      setItem: (key: string, value: string) => { items.set(key, value); },
      removeItem: (key: string) => { items.delete(key); },
      clear: () => items.clear(),
    };
    const first = saveTimelineNote(storage, 'principal-1:', 'a', '  已交付  ');
    const second = saveTimelineNote(storage, 'principal-1:', null, '🎞'.repeat(140));
    saveTimelineNote(storage, 'principal-2:', 'b', 'Other workspace');
    expect(first.text).toBe('已交付');
    expect(readTimelineNotes(storage, 'principal-1:')).toEqual([first, second]);
    expect(second.projectId).toBeNull();
    expect(() => saveTimelineNote(storage, 'principal-1:', 'a', '🎞'.repeat(141))).toThrow(RangeError);
  });

  it('shows standalone posts without any projects and keeps linked posts scoped to their project', () => {
    const notes = [
      { id: 'standalone', projectId: null, at: 11, text: 'General update' },
      { id: 'linked', projectId: 'a', at: 12, text: 'Project update' },
    ];
    const withoutProjects = buildTimeline([], new Map(), notes);
    expect(withoutProjects.map(entry => [entry.id, entry.project])).toEqual([['note:standalone', null]]);
    expect(buildTimeline([project], new Map(), notes).find(entry => entry.id === 'note:linked')?.project?.id).toBe('a');
  });
});
