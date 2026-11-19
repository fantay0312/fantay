// SPDX-License-Identifier: AGPL-3.0-only
// Faces of the Fantay workspace (spec §5.5). Fantay wears the mascot (the zero-JS still, its own silhouette);
// every other agent is a folded paper companion in the five-hue PA identity palette. Group clusters arrange
// up to three faces, each on a 2 px paper collar.
import { useState, type CSSProperties } from 'react';

import { FantayMascotStill } from '../brand/FantayMascot';
import { cn } from '../ui';
import { hueIndex } from './pa-model';
import type { PersonalAgent } from './pa-types';
import styles from './PaAvatar.module.css';

export interface PaAvatarProps {
  agent: PersonalAgent | null; // null → unknown sender, renders '·'
  size: number; // 16 | 20 | 24 | 28 | 32 | 40 | 48 | 64
  fantay: boolean; // caller passes isFantay(index, agent?.id)
  disc?: boolean; // force a disc behind the mascot (clusters)
  dim?: boolean; // disabled agent → opacity .5
  className?: string;
}

const PAPER_FACES = [
  'M3 9Q3 6 7 6Q11 5 13 2Q14 7 19 8Q22 9 21 13Q20 19 14 20Q6 20 4 15Z',
  'M3 8Q4 4 8 6L12 8L18 4Q21 3 21 9V13Q21 19 13 20Q5 20 3 14Z',
  'M4 11Q3 7 6 4Q10 8 15 7Q18 6 21 4Q22 10 20 15Q18 21 11 20Q5 20 4 15Z',
  'M3 11Q4 5 10 6Q13 6 17 3L21 9Q23 15 18 18Q13 22 7 18Q3 16 3 11Z',
  'M3 9Q4 6 8 5L14 4Q20 4 21 8V13Q21 19 16 20H9Q3 19 3 13Z',
] as const;

/* Leave breathing room around the sprite inside the disc. */
const MASCOT_IN_DISC = 0.92;

/** Glyph size step for a disc (spec §5.5 table). */
function glyphStep(size: number): 'xs' | 'sm' | 'md' | 'lg' {
  if (size <= 24) return 'xs';
  if (size <= 34) return 'sm';
  if (size <= 52) return 'md';
  return 'lg';
}

export function PaAvatar({ agent, size, fantay, disc = false, dim = false, className }: PaAvatarProps) {
  const box: CSSProperties = { width: size, height: size };
  if (agent && fantay) {
    return (
      <span
        role="img"
        aria-label={agent.name}
        data-slot="pa-avatar"
        data-fantay=""
        data-disc={disc ? '' : undefined}
        data-dim={dim ? '' : undefined}
        className={cn(styles.face, disc && styles.mascotDisc, className)}
        style={box}
      >
        <FantayMascotStill size={disc ? Math.round(size * MASCOT_IN_DISC) : size} />
      </span>
    );
  }
  if (!agent) {
    return (
      <span aria-hidden data-slot="pa-avatar" data-step={glyphStep(size)} className={cn(styles.face, styles.disc, styles.unknown, className)} style={box}>
        ·
      </span>
    );
  }
  const hue = hueIndex(agent.id);
  const tint = {
    ...box,
    '--pa-hue': `var(--pa-id-${hue})`,
    '--pa-hue-ink': `var(--pa-id-${hue}-ink)`,
  } as CSSProperties;
  return (
    <span
      role="img"
      aria-label={agent.name}
      data-slot="pa-avatar"
      data-hue={hue}
      data-dim={dim ? '' : undefined}
      className={cn(styles.face, styles.disc, styles.tinted, className)}
      style={tint}
    >
      <svg aria-hidden className={styles.paperFace} viewBox="0 0 24 24" focusable="false">
        <path fill="currentColor" d={PAPER_FACES[hue - 1]} />
        <path className={styles.paperFold} d="M6 15Q12 21 19 15Q17 19 12 19Q8 19 6 15Z" />
        <ellipse className={styles.paperEye} cx="9" cy="11.5" rx="1.25" ry="1.55" />
        <ellipse className={styles.paperEye} cx="15" cy="11.5" rx="1.25" ry="1.55" />
      </svg>
    </span>
  );
}

interface Slot {
  /** Face diameter as a share of the cluster. */
  scale: number;
  /** Position of the face's top-left corner as a share of the cluster. */
  x: number;
  y: number;
}

/* 2 faces on a diagonal (65%); 3 in a triangle. With 4+ the third slot is a "+N" disc. The triangle's faces are
   52% (spec: 54%) and barely overlap, so a neighbour's 2 px collar never cuts into a paper face at the
   28–32 px sizes of the roster and the chat header. */
const LAYOUT: Record<2 | 3, Slot[]> = {
  2: [
    { scale: 0.65, x: 0, y: 0 },
    { scale: 0.65, x: 0.35, y: 0.35 },
  ],
  3: [
    { scale: 0.52, x: 0.24, y: 0 },
    { scale: 0.52, x: 0, y: 0.48 },
    { scale: 0.52, x: 0.48, y: 0.48 },
  ],
};

/** A member's character portrait in a cluster slot, cropped to the disc; the paper face when it fails to load. */
function PortraitFace({ member, src, size, collar }: { member: PersonalAgent; src: string; size: number; collar: boolean }) {
  const [failed, setFailed] = useState(false);
  if (failed) return <PaAvatar agent={member} size={size} fantay={false} className={collar ? styles.collar : undefined} />;
  return (
    <span data-slot="pa-avatar" data-portrait="" className={cn(styles.face, styles.portraitFace, collar && styles.collar)} style={{ width: size, height: size }}>
      <img src={src} alt="" draggable={false} className={styles.portraitImg} onError={() => setFailed(true)} />
    </span>
  );
}

export interface PaGroupAvatarProps {
  members: PersonalAgent[];
  fantayId: string | null;
  size: number;
  /** A member's character portrait URL (soul-model `portraitSrc`); members without one keep the paper face. */
  portraitOf?: (agentId: string) => string | null;
}

export function PaGroupAvatar({ members, fantayId, size, portraitOf }: PaGroupAvatarProps) {
  const label = members.map((member) => member.name).join('、');
  const box: CSSProperties = { width: size, height: size };
  const portrait = (member: PersonalAgent) => (member.id === fantayId ? null : portraitOf?.(member.id) ?? null);
  if (members.length <= 1) {
    const only = members[0] ?? null;
    const src = only ? portrait(only) : null;
    return (
      <span role="img" aria-label={label || undefined} data-slot="pa-group-avatar" className={styles.cluster} style={box}>
        <span aria-hidden className={styles.contents}>
          {only && src ? (
            <PortraitFace key={src} member={only} src={src} size={size} collar={false} />
          ) : (
            <PaAvatar agent={only} size={size} fantay={Boolean(only && only.id === fantayId)} />
          )}
        </span>
      </span>
    );
  }
  const overflow = members.length > 3 ? members.length - 2 : 0;
  const faces = overflow ? members.slice(0, 2) : members.slice(0, 3);
  const slots = LAYOUT[faces.length + (overflow ? 1 : 0) === 2 ? 2 : 3];
  const place = (slot: Slot): CSSProperties => {
    const face = Math.round(size * slot.scale);
    return { width: face, height: face, insetInlineStart: Math.round(size * slot.x), top: Math.round(size * slot.y) };
  };
  return (
    <span role="img" aria-label={label} data-slot="pa-group-avatar" className={styles.cluster} style={box}>
      <span aria-hidden className={styles.contents}>
        {faces.map((member, i) => {
          const slot = slots[i]!;
          const face = Math.round(size * slot.scale);
          const src = portrait(member);
          return (
            <span key={member.id} className={styles.slot} style={place(slot)}>
              {src ? (
                <PortraitFace key={src} member={member} src={src} size={face} collar />
              ) : (
                <PaAvatar agent={member} size={face} fantay={member.id === fantayId} disc={member.id === fantayId} className={styles.collar} />
              )}
            </span>
          );
        })}
        {overflow ? (
          <span className={styles.slot} style={place(slots[2]!)}>
            <span className={cn(styles.face, styles.disc, styles.more, styles.collar)} style={{ width: '100%', height: '100%' }}>
              +{overflow}
            </span>
          </span>
        ) : null}
      </span>
    </span>
  );
}
