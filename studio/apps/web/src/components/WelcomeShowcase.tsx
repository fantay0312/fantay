'use client';
// SPDX-License-Identifier: AGPL-3.0-only
// The welcome page's right column. The picture itself is a Stageshow scene (`fantay/stageshow/WelcomeDemo`): one
// request to Fantay and what comes back, told across five tiles (the conversation, the team, the canvas, the film
// and the library). This host only fits it: the scene is drawn at one design size and scaled to the column, so its
// composition holds at every window size, and it sits straight on the page with no tray behind it. The scene and
// the kit load in their own chunk; if that fails the column stays empty beside the sign-in copy.
// Decoration: hidden from assistive tech, and it always runs left to right.
import { Component, Suspense, lazy, useEffect, useRef, useState, type ReactNode } from 'react';

import type { WelcomeDemoCopy } from '../fantay/stageshow/WelcomeDemo';
import { useTheme } from '../fantay/theme/theme';
import styles from './WelcomeShowcase.module.css';

const WelcomeDemo = lazy(() => import('../fantay/stageshow/WelcomeDemo').then((module) => ({ default: module.WelcomeDemo })));

const DESIGN_W = 680;
const DESIGN_H = 872;
const MAX_SCALE = 1.5;

const COPY_ZH: WelcomeDemoCopy = {
  placeholder: '交给 Fantay…',
  working: '正在分工…',
  group: '协作工作室',
  library: '素材库',
  team: [
    { name: '研究员', step: '找参考' },
    { name: 'Fantay', step: '首页与短片' },
    { name: '审阅者', step: '核对成果' },
  ],
  briefs: [
    { ask: '给 Qelora 做官网首页，再剪一支 12 秒预告片', reply: '首页放到画布了，预告片也剪好了，审阅者已核对。' },
    { ask: '做一个艺术展的主页，再配一支预告片', reply: '艺术展主页和预告片都好了，参考取自你的素材库。' },
  ],
};

const COPY_EN: WelcomeDemoCopy = {
  placeholder: 'Ask Fantay…',
  working: 'Splitting up the work…',
  group: 'Studio team',
  library: 'Library',
  team: [
    { name: 'Researcher', step: 'References' },
    { name: 'Fantay', step: 'Page and film' },
    { name: 'Reviewer', step: 'Review' },
  ],
  briefs: [
    { ask: 'A homepage for Qelora, plus a 12-second trailer', reply: 'The homepage is on the canvas, the trailer is cut, and the review passed.' },
    { ask: 'A page for the art show, with a trailer', reply: 'Page and trailer are ready, built on references from your library.' },
  ],
};

class SceneBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  override render() {
    return this.state.failed ? null : this.props.children;
  }
}

export function WelcomeShowcase({ isZh }: { isZh: boolean }) {
  const { resolved } = useTheme();
  const sceneRef = useRef<HTMLDivElement | null>(null);
  const [scale, setScale] = useState(0);

  // Fit the whole picture inside the column and center it there.
  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(([entry]) => {
      const width = entry?.contentRect.width ?? 0;
      const height = entry?.contentRect.height ?? 0;
      if (!width || !height) return;
      setScale(Math.min(width / DESIGN_W, height / DESIGN_H, MAX_SCALE));
    });
    observer.observe(scene);
    return () => observer.disconnect();
  }, []);

  return (
    <div ref={sceneRef} className={styles.scene} aria-hidden="true" dir="ltr">
      {scale > 0 ? (
        <div className={styles.picture} style={{ width: Math.floor(DESIGN_W * scale), height: Math.floor(DESIGN_H * scale) }}>
          <SceneBoundary>
            <Suspense fallback={null}>
              <WelcomeDemo copy={isZh ? COPY_ZH : COPY_EN} theme={resolved} width={DESIGN_W} height={DESIGN_H} />
            </Suspense>
          </SceneBoundary>
        </div>
      ) : null}
    </div>
  );
}
