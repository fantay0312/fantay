// SPDX-License-Identifier: Apache-2.0
// Canvas pages of a board: every node belongs to one page, and a board that never added a page has one implicit page.
import { BOARD_DEFAULT_PAGE_ID, type BoardContent, type BoardNode, type BoardPage } from '../api/board.js';

const IMPLICIT_PAGES: readonly BoardPage[] = Object.freeze([Object.freeze({ id: BOARD_DEFAULT_PAGE_ID, title: 'Page 1' })]);

/** The pages in tab order; never empty. */
export function boardPagesOf(content: Pick<BoardContent, 'pages'>): readonly BoardPage[] {
  return content.pages && content.pages.length > 0 ? content.pages : IMPLICIT_PAGES;
}

/** `id` when it names a page, else the first page. */
export function resolveBoardPageId(pages: readonly BoardPage[], id: string | null | undefined): string {
  return id && pages.some((page) => page.id === id) ? id : pages[0]!.id;
}

/** The page a node shows on: its own when that page exists, else the first page. */
export function boardNodePageId(node: Pick<BoardNode, 'page'>, pages: readonly BoardPage[]): string {
  return resolveBoardPageId(pages, node.page);
}

export function boardNodesOnPage<T extends Pick<BoardNode, 'page'>>(nodes: readonly T[], pages: readonly BoardPage[], pageId: string): T[] {
  const firstPage = pages[0]!.id;
  const known = new Set(pages.map((page) => page.id));
  return nodes.filter((node) => (node.page !== undefined && known.has(node.page) ? node.page : firstPage) === pageId);
}

/** `Page N` with the lowest free number at or above the page count + 1. */
export function nextBoardPageTitle(pages: readonly BoardPage[]): string {
  const taken = new Set(pages.map((page) => page.title));
  let number = pages.length + 1;
  while (taken.has(`Page ${number}`)) number += 1;
  return `Page ${number}`;
}
