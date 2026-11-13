'use client';
/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Fantay — derived from Doop (https://github.com/kgoedecke/doop)
 *   source: src/components/FrameView.tsx (iframe density / counter-zoom style L1203-1226) @ d261a85d3f9d87ac0653bb8512915f4e5bdff2b9
 *   Copyright (c) the Doop contributors. Licensed under the GNU Affero General Public License v3.0
 *   (see licenses/doop-AGPL-3.0.txt and THIRD_PARTY_NOTICES.md). "Doop" is a trademark of its
 *   owner and is not used to brand Fantay.
 * Modifications Copyright (c) 2026 Fantay contributors, AGPL-3.0-only: the live surface of a board frame (spec 03
 *   §4.1, §5.2): the cover stays mounted under the iframe and fades once the document rendered, the pending
 *   iframe of a reload sits invisible under the current one until it loads, URL or srcdoc transport, the board's
 *   sandbox and motion-activity attributes.
 */
import { useEffect, useRef, type ReactNode } from 'react';

import { bindMotionPreviewActivity, unbindMotionPreviewActivity } from '../../../../runtime/motion-preview-activity';
import { counterZoom, FRAME_DOCUMENTS_TAKE_ZOOM_AS_DENSITY } from '../../camera/layout-zoom';
import type { FrameLiveSlot } from './use-frame-live';
import styles from './frame.module.css';

export type FrameRole = 'current' | 'pending';

export interface FrameSurfaceProps {
  title: string;
  width: number;
  height: number;
  layoutZoom: number;
  sandbox: string;
  current: FrameLiveSlot | null;
  pending: FrameLiveSlot | null;
  /** the board tab is visible and the node is live (`data-od-active`) */
  active: boolean;
  /** motion previews play while the node is selected or hovered */
  motionActive: boolean;
  motionMuted: boolean;
  /** shown under the iframe (cover or placeholder); hidden once `ready` */
  underlay: ReactNode;
  ready: boolean;
  /** an iframe mounted or changed its role */
  onFrame(iframe: HTMLIFrameElement, role: FrameRole): void;
  /** an iframe unmounted */
  onFrameGone(iframe: HTMLIFrameElement): void;
  onLoad(role: FrameRole, key: string): void;
}

interface FrameElementProps extends Pick<FrameSurfaceProps, 'title' | 'width' | 'height' | 'layoutZoom' | 'sandbox' | 'active' | 'motionActive' | 'motionMuted' | 'onFrame' | 'onFrameGone' | 'onLoad'> {
  slot: FrameLiveSlot;
  role: FrameRole;
}

function FrameElement({ slot, role, title, width, height, layoutZoom, sandbox, active, motionActive, motionMuted, onFrame, onFrameGone, onLoad }: FrameElementProps) {
  const ref = useRef<HTMLIFrameElement | null>(null);
  const roleRef = useRef(role);
  roleRef.current = role;
  const callbacks = useRef({ onFrame, onFrameGone });
  callbacks.current = { onFrame, onFrameGone };

  useEffect(() => {
    const iframe = ref.current;
    if (!iframe) return undefined;
    bindMotionPreviewActivity(iframe);
    return () => {
      unbindMotionPreviewActivity(iframe);
      callbacks.current.onFrameGone(iframe);
    };
  }, []);

  // the window reference survives navigations inside the iframe; report it with its role
  useEffect(() => {
    const iframe = ref.current;
    if (iframe) callbacks.current.onFrame(iframe, role);
  }, [role]);

  /* The world is laid out at CSS zoom k, which an iframe passes into its document. Chromium takes it as pixel
     density (design px viewport, k× raster); other engines lay the document out at the zoomed width, so the zoom is
     undone here and the scale restores the box. */
  const style = {
    width,
    height,
    ...(FRAME_DOCUMENTS_TAKE_ZOOM_AS_DENSITY ? null : { zoom: counterZoom(layoutZoom), transform: `scale(${layoutZoom})` }),
    transformOrigin: '0 0',
  };
  const transportProps = slot.transport.kind === 'url' ? { src: slot.transport.src } : { srcDoc: slot.transport.srcDoc };
  return (
    <iframe
      ref={ref}
      className={styles.iframe}
      data-role={role}
      data-transport={slot.transport.kind}
      data-testid="board-frame-iframe"
      title={title}
      sandbox={sandbox}
      referrerPolicy="no-referrer"
      data-od-active={active ? 'true' : 'false'}
      data-od-motion-active={motionActive ? 'true' : 'false'}
      data-od-motion-muted={motionMuted ? 'true' : 'false'}
      style={style}
      onLoad={() => onLoad(roleRef.current, slot.key)}
      {...transportProps}
    />
  );
}

export function FrameSurface(props: FrameSurfaceProps) {
  const slots: Array<{ slot: FrameLiveSlot; role: FrameRole }> = [];
  if (props.current) slots.push({ slot: props.current, role: 'current' });
  if (props.pending) slots.push({ slot: props.pending, role: 'pending' });
  return (
    <div className={styles.surface} data-ready={props.ready ? 'true' : 'false'}>
      <div className={styles.underlay} data-hidden={props.ready && props.current ? '' : undefined}>
        {props.underlay}
      </div>
      {/* keyed by document: a pending iframe that becomes current keeps its element (no reload) */}
      {slots.map(({ slot, role }) => (
        <FrameElement
          key={slot.key}
          slot={slot}
          role={role}
          title={props.title}
          width={props.width}
          height={props.height}
          layoutZoom={props.layoutZoom}
          sandbox={props.sandbox}
          active={props.active}
          motionActive={props.motionActive}
          motionMuted={props.motionMuted}
          onFrame={props.onFrame}
          onFrameGone={props.onFrameGone}
          onLoad={props.onLoad}
        />
      ))}
    </div>
  );
}
