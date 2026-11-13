// SPDX-License-Identifier: AGPL-3.0-only
// Derived from dsh-media-desk (https://github.com/woniuniuniu/dsh-media-desk), MIT, Copyright (c) 2026 woniuniuniu
// 持久化：<数据根>/workbench/state.json，用户文件在 files/ 下。数据根由 server.ts 传入，这里从不自己推算。
// 可能有不止一个 daemon 进程读同一份数据，所以每次读写前都按 mtime 判断是否需要重读。
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { WorkbenchState } from '@open-design/contracts';
import { buildSeed, migrateState } from './seed.js';

export const MAX_UNDO = 30;

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const keyed = (list: unknown[]): list is Array<{ id: string }> => list.every(row => isObject(row) && typeof row.id === 'string');

function revertList(before: Array<{ id: string }>, after: Array<{ id: string }>, current: Array<{ id: string }>): Array<{ id: string }> {
  const was = new Map(before.map(row => [row.id, row]));
  const now = new Map(after.map(row => [row.id, row]));
  // 这一步新增的行撤掉，两边都有的行逐字段撤回，其余（之后才加的）原样保留
  const result = current
    .filter(row => !(now.has(row.id) && !was.has(row.id)))
    .map(row => (was.has(row.id) && now.has(row.id) ? revertChange(was.get(row.id), now.get(row.id), row) as { id: string } : row));
  // 这一步删掉的行放回原来的位置
  const present = new Set(result.map(row => row.id));
  before.forEach((row, index) => {
    if (now.has(row.id) || present.has(row.id)) return;
    result.splice(Math.min(index, result.length), 0, structuredClone(row));
    present.add(row.id);
  });
  return result;
}

/**
 * 三方合并式撤销：只撤回这一步改过、之后又没被别的操作改动的部分。
 * 撤销「切换风格」不会抹掉之后生成的成稿；撤销「对话改标题」不会把之后画好的图退回去。
 */
export function revertChange(before: unknown, after: unknown, current: unknown): unknown {
  if (same(before, after)) return current;
  if (same(current, after)) return before === undefined ? undefined : structuredClone(before);
  if (isObject(before) && isObject(after) && isObject(current)) {
    const result: Record<string, unknown> = { ...current };
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
      const value = revertChange(before[key], after[key], current[key]);
      if (value === undefined) delete result[key];
      else result[key] = value;
    }
    return result;
  }
  if (Array.isArray(before) && Array.isArray(after) && Array.isArray(current)) {
    if (keyed(before) && keyed(after) && keyed(current) && (before.length || after.length)) return revertList(before, after, current);
    if (before.length === after.length && after.length === current.length) return current.map((row, index) => revertChange(before[index], after[index], row));
  }
  // 之后又被改过且无法逐项合并时，保留现在的值
  return current;
}

interface UndoEntry { label: string; before: string; after: string }

export class WorkbenchStore {
  readonly root: string;
  readonly file: string;
  readonly filesDir: string;
  private state: WorkbenchState | null = null;
  private mtimeMs = 0;
  private readonly undo: UndoEntry[] = [];
  private queue: Promise<unknown> = Promise.resolve();

  /** @param root 工作台目录，由调用方从 RUNTIME_DATA_DIR 派生。 */
  constructor(root: string) {
    this.root = root;
    this.file = path.join(root, 'state.json');
    this.filesDir = path.join(root, 'files');
  }

  get canUndo(): boolean { return this.undo.length > 0; }
  get undoLabel(): string | null { return this.undo.at(-1)?.label ?? null; }

  private async refresh(): Promise<WorkbenchState> {
    await mkdir(this.filesDir, { recursive: true });
    let info: { mtimeMs: number } | null = null;
    try {
      info = await stat(this.file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (!info) {
      this.state = buildSeed(new Date());
      await this.persist();
      return this.state;
    }
    if (this.state && info.mtimeMs === this.mtimeMs) return this.state;
    this.state = migrateState(JSON.parse(await readFile(this.file, 'utf8')));
    this.mtimeMs = info.mtimeMs;
    return this.state;
  }

  private async persist(): Promise<void> {
    const tmp = `${this.file}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(this.state));
    await rename(tmp, this.file);
    this.mtimeMs = (await stat(this.file)).mtimeMs;
  }

  /** 串行执行，避免同一进程内的并发写互相覆盖。 */
  private run<T>(task: () => Promise<T>): Promise<T> {
    const next = this.queue.then(task, task);
    this.queue = next.catch(() => undefined);
    return next;
  }

  read(): Promise<WorkbenchState> {
    return this.run(() => this.refresh());
  }

  /**
   * 就地修改状态并落盘。label 显示在撤销入口上；返回 mutate 的返回值。
   * 什么都没改的操作不占撤销位，免得用户点撤销却没反应。
   */
  mutate<T>(label: string, mutate: (state: WorkbenchState) => T | Promise<T>, { undoable = true }: { undoable?: boolean } = {}): Promise<T> {
    return this.run(async () => {
      const state = await this.refresh();
      const before = undoable ? JSON.stringify(state) : null;
      const result = await mutate(state);
      if (undoable && before !== null) {
        const after = JSON.stringify(this.state);
        if (after !== before) {
          this.undo.push({ label, before, after });
          if (this.undo.length > MAX_UNDO) this.undo.shift();
        }
      }
      await this.persist();
      return result;
    });
  }

  undoLast(): Promise<string | null> {
    return this.run(async () => {
      const entry = this.undo.pop();
      if (!entry) return null;
      const state = await this.refresh();
      this.state = revertChange(JSON.parse(entry.before), JSON.parse(entry.after), state) as WorkbenchState;
      await this.persist();
      return entry.label;
    });
  }
}
