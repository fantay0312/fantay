// SPDX-License-Identifier: AGPL-3.0-only
// What the Files library remembers per project while the app runs: the view, the sort, the type
// filter, the search and the scroll position. The workspace unmounts the surface whenever another
// tab is in front; this store is why coming back finds the library as it was left.
// The open folder is not here: the workspace already keeps it (`navState`).
// In memory only. A restart opens every project fresh, in the view chosen last.
import { SORT_START, type LibraryFilter, type LibrarySort } from './library-model';

export type LibraryViewMode = 'grid' | 'list';

export interface LibraryPrefs {
  view: LibraryViewMode;
  sort: LibrarySort;
  filter: LibraryFilter;
  query: string;
  /** The scroll offset, valid only for the listing named by `scrollKey`. */
  scrollTop: number;
  scrollKey: string;
}

const store = new Map<string, LibraryPrefs>();
/** A project opened for the first time starts in the view the person chose last, anywhere. */
let lastView: LibraryViewMode = 'grid';

export function readLibraryPrefs(projectId: string): LibraryPrefs {
  return (
    store.get(projectId) ?? {
      view: lastView,
      sort: { key: 'modified', direction: SORT_START.modified },
      filter: 'all',
      query: '',
      scrollTop: 0,
      scrollKey: '',
    }
  );
}

export function writeLibraryPrefs(projectId: string, prefs: LibraryPrefs): void {
  store.set(projectId, prefs);
  lastView = prefs.view;
}

export function resetLibraryStoreForTests(): void {
  store.clear();
  lastView = 'grid';
}
