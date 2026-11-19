// fx-governance-allow-raw: a path segment is a bare text link inside the breadcrumb row, which no button primitive models
// SPDX-License-Identifier: AGPL-3.0-only
// Adapted from t3code apps/web/src/components/files/FileBreadcrumbs.tsx and filePath.ts @ c5e6b24f
// (MIT): the path as an ordered list of crumbs, folders as buttons, the file as the current page.
// Changed here: no per-folder contents menu (the tree sits next to it), and when the row is too
// narrow the leading folders collapse into "…" so the file name always stays readable.
import { ChevronRight } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';

import styles from './CodeSurface.module.css';

export interface BreadcrumbProps {
  /** Project-relative path with forward slashes. */
  path: string;
  /** A folder segment was clicked. */
  onRevealFolder(dirPath: string): void;
}

interface Crumb {
  label: string;
  path: string;
}

/** "src/app/page.tsx" → src, src/app, src/app/page.tsx. */
export function fileBreadcrumbs(path: string): Crumb[] {
  const parts = path.split('/').filter(Boolean);
  return parts.map((label, index) => ({ label, path: parts.slice(0, index + 1).join('/') }));
}

function Separator(): JSX.Element {
  return <ChevronRight className={styles.crumbSeparator} size={12} strokeWidth={1.75} aria-hidden="true" />;
}

export function Breadcrumb({ path, onRevealFolder }: BreadcrumbProps): JSX.Element {
  const crumbs = fileBreadcrumbs(path);
  const folders = crumbs.slice(0, -1);
  const file = crumbs[crumbs.length - 1];
  const navRef = useRef<HTMLElement | null>(null);
  // How many leading folders are folded into "…".
  const [hidden, setHidden] = useState(0);
  // Every folder is folded and the row still overflows: only then may the file name itself truncate.
  const [tight, setTight] = useState(false);
  // Bumped by a resize, so the fit is measured again from the full path.
  const [, setMeasure] = useState(0);

  useEffect(() => {
    const nav = navRef.current;
    if (!nav || typeof ResizeObserver === 'undefined') return;
    let width = nav.clientWidth;
    const observer = new ResizeObserver(() => {
      // No width means the surface is hidden, not resized: the fold it had stands for its return.
      if (nav.clientWidth === width || nav.clientWidth === 0) return;
      width = nav.clientWidth;
      setHidden(0);
      setTight(false);
      setMeasure((n) => n + 1);
    });
    observer.observe(nav);
    return () => observer.disconnect();
  }, []);

  // Runs after every render and before paint: fold one more folder while the list is wider than the
  // row. It settles in at most one pass per folder, and the reader never sees the intermediate steps.
  useLayoutEffect(() => {
    const nav = navRef.current;
    if (!nav || tight) return;
    if (nav.scrollWidth <= nav.clientWidth + 1) return;
    if (hidden < folders.length) setHidden(hidden + 1);
    else setTight(true);
  });

  const visibleFolders = folders.slice(hidden);
  const hiddenPath = hidden > 0 ? folders[hidden - 1]?.path : undefined;

  return (
    <nav ref={navRef} className={styles.crumbs} aria-label={path} data-tight={tight || undefined}>
      <ol className={styles.crumbList}>
        {hidden > 0 ? (
          <li className={styles.crumbItem}>
            <span className={styles.crumbEllipsis} title={hiddenPath}>
              …
            </span>
            <Separator />
          </li>
        ) : null}
        {visibleFolders.map((crumb) => (
          <li key={crumb.path} className={styles.crumbItem}>
            <button
              type="button"
              className={`${styles.control} ${styles.crumb}`}
              title={crumb.path}
              onClick={() => onRevealFolder(crumb.path)}
            >
              {crumb.label}
            </button>
            <Separator />
          </li>
        ))}
        {file ? (
          <li className={styles.crumbItem} data-current="true">
            <span className={styles.crumbFile} aria-current="page" title={path}>
              {file.label}
            </span>
          </li>
        ) : null}
      </ol>
    </nav>
  );
}
