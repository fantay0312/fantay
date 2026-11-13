// SPDX-License-Identifier: AGPL-3.0-only
// Web command registry (spec 02 §5.3). One stack per command id: the most recently registered live
// handler wins, and unregistering restores the previous one. The shell registers newProject, newChat,
// toggleSidebar, openSettings and search; the board registers `fantay.board.*` while it is mounted and
// active; the design host registers `fantay.design.import`. Desktop menu commands arrive through the
// host `menu` capability and are dispatched here by the shell.

export type FantayCommandId =
  | 'fantay.newProject' | 'fantay.newChat' | 'fantay.toggleSidebar' | 'fantay.openSettings' | 'fantay.search'
  | 'fantay.design.import'
  | 'fantay.board.zoomIn' | 'fantay.board.zoomOut' | 'fantay.board.zoomFit' | 'fantay.board.zoomTo' | 'fantay.board.insertFiles';

export interface FantayCommandPayloads {
  'fantay.board.zoomTo': { zoom: number }; // 1 = 100%
  'fantay.board.insertFiles': { paths: string[] }; // project-relative paths just written
}

export type FantayCommandHandler<I extends FantayCommandId> =
  (payload: I extends keyof FantayCommandPayloads ? FantayCommandPayloads[I] : undefined) => void | boolean;

interface CommandEntry {
  readonly handler: (payload: unknown) => void | boolean;
}

const stacks = new Map<FantayCommandId, CommandEntry[]>();

/** Stack semantics: the most recently registered live handler wins; returns an unregister fn. */
export function registerFantayCommand<I extends FantayCommandId>(id: I, handler: FantayCommandHandler<I>): () => void {
  const entry: CommandEntry = { handler: handler as (payload: unknown) => void | boolean };
  const stack = stacks.get(id);
  if (stack) stack.push(entry);
  else stacks.set(id, [entry]);
  let registered = true;
  return () => {
    if (!registered) return;
    registered = false;
    const current = stacks.get(id);
    if (!current) return;
    const index = current.lastIndexOf(entry);
    if (index >= 0) current.splice(index, 1);
    if (current.length === 0) stacks.delete(id);
  };
}

/** true when a handler ran and did not return false. */
export function runFantayCommand<I extends FantayCommandId>(
  id: I,
  ...payload: I extends keyof FantayCommandPayloads ? [FantayCommandPayloads[I]] : []
): boolean {
  const stack = stacks.get(id);
  const top = stack?.[stack.length - 1];
  if (!top) return false;
  return top.handler(payload[0]) !== false;
}

export function resetFantayCommandsForTests(): void {
  stacks.clear();
}
