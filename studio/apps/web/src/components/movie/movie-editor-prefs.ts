import { useCallback, useSyncExternalStore } from 'react';

/**
 * Editor toggles shared by the timeline toolbar and the keyboard handler in MovieStudio, persisted per user.
 * Storage can be unavailable (private mode, blocked site data); every access is guarded and falls back to memory.
 */
export interface MovieEditorPrefs {
  /** 主轨磁吸: cuts on the main track close their gap. */
  magnet: boolean;
  /** 自动吸附 to clip edges and the playhead. */
  snap: boolean;
  /** 预览轴: hovering the paused timeline previews that frame. */
  skim: boolean;
  /** What video clips show: thumbnails or their linked-audio waveform. */
  clipDisplay: 'frames' | 'waveform';
}

export const MOVIE_EDITOR_PREF_DEFAULTS: MovieEditorPrefs = { magnet: true, snap: true, skim: false, clipDisplay: 'frames' };

const PREFIX = 'fantay.movie.';
const memory = new Map<string, unknown>();
const listeners = new Set<() => void>();

function read<K extends keyof MovieEditorPrefs>(key: K): MovieEditorPrefs[K] {
  if (memory.has(key)) return memory.get(key) as MovieEditorPrefs[K];
  let value: MovieEditorPrefs[K] = MOVIE_EDITOR_PREF_DEFAULTS[key];
  try {
    const raw = window.localStorage.getItem(PREFIX + key);
    if (raw !== null) {
      const parsed = JSON.parse(raw) as unknown;
      if (typeof parsed === typeof MOVIE_EDITOR_PREF_DEFAULTS[key]) value = parsed as MovieEditorPrefs[K];
    }
  } catch { /* storage unavailable: keep the default */ }
  memory.set(key, value);
  return value;
}

export function setMoviePref<K extends keyof MovieEditorPrefs>(key: K, value: MovieEditorPrefs[K]): void {
  memory.set(key, value);
  try { window.localStorage.setItem(PREFIX + key, JSON.stringify(value)); } catch { /* memory only */ }
  listeners.forEach(listener => listener());
}

export function getMoviePref<K extends keyof MovieEditorPrefs>(key: K): MovieEditorPrefs[K] {
  return read(key);
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function useMoviePref<K extends keyof MovieEditorPrefs>(key: K): [MovieEditorPrefs[K], (value: MovieEditorPrefs[K]) => void] {
  const value = useSyncExternalStore(subscribe, () => read(key), () => MOVIE_EDITOR_PREF_DEFAULTS[key]);
  const set = useCallback((next: MovieEditorPrefs[K]) => setMoviePref(key, next), [key]);
  return [value, set];
}

/** Test helper: forget cached values so the next read goes back to storage/defaults. */
export function resetMoviePrefsForTests(): void {
  memory.clear();
  listeners.forEach(listener => listener());
}
