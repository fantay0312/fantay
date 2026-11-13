'use client';
// SPDX-License-Identifier: AGPL-3.0-only
// Empty states that show the product working (Stageshow, src/vendor/stageshow). Each demo is a pure scene behind a
// lazy boundary: the kit and its stylesheets stay out of the main bundle, and a failed chunk leaves the empty state as
// it was. The scenes are decoration beside real copy, so they are hidden from assistive tech and always run
// left to right. Strings reuse the app's own labels wherever the real product shows the same word.
import { Component, Suspense, lazy, type ReactNode } from 'react';

import { useT } from '../../i18n';
import { useTheme } from '../theme/theme';

const BoardDemo = lazy(() => import('./BoardDemo').then((module) => ({ default: module.BoardDemo })));
const MovieDemo = lazy(() => import('./MovieDemo').then((module) => ({ default: module.MovieDemo })));
const SystemDemo = lazy(() => import('./SystemDemo').then((module) => ({ default: module.SystemDemo })));

/** The fictional company in the generated page; a name, so it is the same in every language. */
const PAGE_BRAND = 'Verdant';

class DemoBoundary extends Component<{ children: ReactNode; fallback: ReactNode }, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  override render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

function DemoSlot({
  ratio,
  fallback = null,
  className = '',
  children,
}: {
  ratio: number;
  fallback?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div dir="ltr" aria-hidden className={`w-full ${className}`}>
      <DemoBoundary fallback={fallback}>
        <Suspense fallback={<div style={{ aspectRatio: ratio }} />}>{children}</Suspense>
      </DemoBoundary>
    </div>
  );
}

export function BoardEmptyDemo({ fallback }: { fallback?: ReactNode }) {
  const t = useT();
  const { resolved } = useTheme();
  return (
    <DemoSlot ratio={540 / 336} fallback={fallback}>
      <BoardDemo
        theme={resolved}
        copy={{
          prompt: t('demo.board.prompt'),
          placeholder: t('chat.composerPlaceholder'),
          read: t('chat.record.verb.read'),
          create: t('chat.record.verb.write'),
          brand: PAGE_BRAND,
          headline: t('demo.page.headline'),
          cta: t('demo.page.cta'),
          navigate: t('board.mode.navigate'),
          edit: t('board.mode.edit'),
          capture: t('board.mode.capture'),
        }}
      />
    </DemoSlot>
  );
}

export function MovieEmptyDemo() {
  const t = useT();
  const { resolved } = useTheme();
  return (
    <DemoSlot ratio={504 / 296} className="mb-1.5">
      <MovieDemo
        theme={resolved}
        copy={{
          brief: t('demo.movie.brief'),
          placeholder: t('chat.composerPlaceholder'),
          approve: t('motion.storyboard.approve'),
          delivered: t('motion.library.delivered'),
        }}
      />
    </DemoSlot>
  );
}

export function SystemEmptyDemo({ fallback }: { fallback?: ReactNode }) {
  const t = useT();
  const { resolved } = useTheme();
  return (
    <DemoSlot ratio={504 / 290} fallback={fallback}>
      <SystemDemo
        theme={resolved}
        copy={{
          edit: t('chat.record.verb.edit'),
          brand: PAGE_BRAND,
          headline: t('demo.page.headline'),
          cta: t('demo.page.cta'),
        }}
      />
    </DemoSlot>
  );
}
