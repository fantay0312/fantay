// SPDX-License-Identifier: AGPL-3.0-only
// 角色资料 ▸ 立绘 (STAGE2 6.3): one image per emotion. Eight 3:4 wells on the character's theme paper, each with
// 上传 / 更换 and 移除. Images are re-encoded like a portrait (`imageToAsset`: long side at most 1024 px, WebP, at most
// 1.5 MB, transparency kept) through one shared upload without a crop step. Nothing is saved until the editor's 保存.
import { useEffect, useId, useRef, useState } from 'react';
import type { PaChatTheme } from '@open-design/contracts';
import { PA_EMOTIONS } from '@open-design/contracts/soul';

import { useT } from '../../../i18n';
import { Button } from '../../ui';
import { paSoulAssetUrl } from '../pa-api';
import type { PaEmotion, PaSprites } from '../pa-types';
import { useSoulImageUpload } from './SoulProfileModal';
import styles from './SoulProfileModal.module.css';

export interface SoulSpritesEditorProps {
  value: PaSprites;
  onChange(next: PaSprites): void;
  /** The character's display name (the English lede names it). */
  name: string;
  /** The character's own theme: the wells show the images on its paper, as the chat will. */
  theme: PaChatTheme;
}

/** The sprites without one emotion (keys come from PA_EMOTIONS only). */
function without(sprites: PaSprites, emotion: PaEmotion): PaSprites {
  const next: PaSprites = {};
  for (const key of PA_EMOTIONS) {
    const id = sprites[key];
    if (key !== emotion && id) next[key] = id;
  }
  return next;
}

export function SoulSpritesEditor({ value, onChange, name, theme }: SoulSpritesEditorProps) {
  const t = useT();
  const uid = useId();
  const sprites = value ?? {};
  const latest = useRef(sprites);
  latest.current = sprites;
  // The well being filled: a ref for the upload callback, a state for the render.
  const target = useRef<PaEmotion | null>(null);
  const [active, setActive] = useState<PaEmotion | null>(null);
  const [errorAt, setErrorAt] = useState<PaEmotion | null>(null);
  const upload = useSoulImageUpload((assetId) => {
    const emotion = target.current;
    if (emotion) onChange({ ...latest.current, [emotion]: assetId });
  });
  useEffect(() => {
    if (upload.error) setErrorAt(target.current);
  }, [upload.error]);

  const choose = (emotion: PaEmotion) => {
    target.current = emotion;
    setActive(emotion);
    upload.choose();
  };
  const count = PA_EMOTIONS.filter((emotion) => Boolean(sprites[emotion])).length;

  return (
    <div className="flex min-w-0 flex-col gap-3" data-testid="pa-profile-sprites">
      <div className={styles.spritesHead}>
        <p className={styles.spritesLede}>{t('pa.soul.editor.sprites.lede', { name })}</p>
        <span className={styles.spritesCount}>{t('pa.soul.editor.sprites.count', { n: count, total: PA_EMOTIONS.length })}</span>
      </div>
      <div className={styles.spriteGrid} role="list">
        {PA_EMOTIONS.map((emotion) => {
          const id = sprites[emotion] ?? null;
          const filling = upload.busy && active === emotion;
          const src = filling && upload.preview ? upload.preview : paSoulAssetUrl(id);
          return (
            <div
              key={emotion}
              role="listitem"
              className={styles.spriteWell}
              data-testid="pa-sprite-well"
              data-emotion={emotion}
              data-set={id ? '' : undefined}
            >
              <div className={styles.spriteFrame} data-pa-skin={theme} data-busy={filling ? '' : undefined}>
                {src ? (
                  <img src={src} alt="" draggable={false} decoding="async" className={styles.spriteImage} />
                ) : (
                  <span className={styles.spriteEmpty}>{t('pa.soul.editor.sprites.empty')}</span>
                )}
              </div>
              <span id={`${uid}-${emotion}`} className={styles.spriteName}>
                {t(`pa.soul.emotion.${emotion}`)}
              </span>
              {/* Each button is named by its own text and the well's mood (更换 平静), not 更换 eight times. */}
              <div className={styles.spriteActions}>
                <Button
                  id={`${uid}-${emotion}-pick`}
                  aria-labelledby={`${uid}-${emotion}-pick ${uid}-${emotion}`}
                  size="sm"
                  variant="secondary"
                  loading={filling}
                  disabled={upload.busy && !filling}
                  onClick={() => choose(emotion)}
                >
                  {t(id ? 'pa.soul.editor.sprites.replace' : 'pa.soul.editor.sprites.upload')}
                </Button>
                {id ? (
                  <Button
                    id={`${uid}-${emotion}-remove`}
                    aria-labelledby={`${uid}-${emotion}-remove ${uid}-${emotion}`}
                    size="sm"
                    variant="bare"
                    disabled={filling}
                    onClick={() => onChange(without(latest.current, emotion))}
                  >
                    {t('pa.soul.editor.sprites.remove')}
                  </Button>
                ) : null}
              </div>
              {upload.error && errorAt === emotion ? (
                <p role="alert" className={styles.portraitError}>
                  {upload.error}
                </p>
              ) : null}
            </div>
          );
        })}
      </div>
      <p className={styles.caption}>{t('pa.soul.editor.sprites.stageHint')}</p>
      {upload.input}
    </div>
  );
}
