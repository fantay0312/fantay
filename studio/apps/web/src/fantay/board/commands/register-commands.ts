// SPDX-License-Identifier: AGPL-3.0-only
// `fantay.board.*` shell commands (plan R7, amendment B5): registered only while the board is the active root
// tab, so desktop menu zoom and the header zoom menu are no-ops elsewhere (unhandled board commands are silent).
import { registerFantayCommand } from '../../shell/commands';
import type { BoardCommands } from './board-commands';

export function registerBoardShellCommands(commands: BoardCommands): () => void {
  const unregister = [
    registerFantayCommand('fantay.board.zoomIn', () => {
      commands.zoomIn();
    }),
    registerFantayCommand('fantay.board.zoomOut', () => {
      commands.zoomOut();
    }),
    registerFantayCommand('fantay.board.zoomFit', () => {
      commands.zoomToFit();
    }),
    registerFantayCommand('fantay.board.zoomTo', (payload) => {
      commands.zoomTo(payload.zoom);
    }),
    registerFantayCommand('fantay.board.insertFiles', (payload) => {
      commands.ensureFileNodes(payload.paths, { origin: 'local', select: true, reveal: true });
    }),
  ];
  return () => {
    for (const off of unregister) off();
  };
}
