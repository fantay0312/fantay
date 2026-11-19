import { describe, expect, it } from 'vitest';
import { PA_EMOTIONS, PA_EMOTION_META, emotionFromAssetName, emotionOf, spriteFor } from '../../src/soul/index';
import type { PaSprites } from '../../src/soul/index';

describe('emotionOf', () => {
  it.each([
    ['开心', 'happy'], ['不开心', 'sad'], ['有点困', 'sleepy'], ['害羞地笑', 'shy'], ['又气又笑', 'angry'],
    ['not happy', 'neutral'], ['Excited!!', 'happy'], ['relieved', 'happy'], ['平静', 'neutral'],
    ['没有开心', 'neutral'], ['不太高兴', 'neutral'], ['有点紧张', 'worried'], ['担心你', 'worried'], ['想哭', 'sad'],
    ['惊喜！', 'surprised'], ['脸红', 'shy'], ['smiling softly', 'happy'], ['a bit worried', 'worried'],
    ['so tired', 'sleepy'], ['never angry', 'neutral'], ['ＨＡＰＰＹ', 'happy'], ['有点委屈但很开心', 'sad'],
  ])('%j → %s', (mood, emotion) => {
    expect(emotionOf(mood)).toBe(emotion);
  });

  it('answers neutral when nothing matches', () => {
    expect(emotionOf('')).toBe('neutral');
    expect(emotionOf(null)).toBe('neutral');
    expect(emotionOf(undefined)).toBe('neutral');
    expect(emotionOf('xyz')).toBe('neutral');
    expect(emotionOf(42 as unknown as string)).toBe('neutral');
  });

  it('maps every emotion id and every meta name to itself', () => {
    for (const emotion of PA_EMOTIONS) {
      expect(emotionOf(emotion)).toBe(emotion);
      expect(emotionOf(PA_EMOTION_META[emotion].zh)).toBe(emotion);
      expect(emotionOf(PA_EMOTION_META[emotion].en)).toBe(emotion);
      expect(emotionOf(PA_EMOTION_META[emotion].en.toUpperCase())).toBe(emotion);
    }
    expect(Object.keys(PA_EMOTION_META)).toEqual([...PA_EMOTIONS]);
  });
});

describe('emotionFromAssetName', () => {
  it('reads archive image names and answers null when nothing matches', () => {
    expect(emotionFromAssetName('xyz')).toBeNull();
    expect(emotionFromAssetName('')).toBeNull();
    expect(emotionFromAssetName('happy_01.png')).toBe('happy');
    expect(emotionFromAssetName('Sad-face.webp')).toBe('sad');
    expect(emotionFromAssetName('neutral')).toBe('neutral');
    expect(emotionFromAssetName('害羞')).toBe('shy');
    expect(emotionFromAssetName('default.png')).toBe('neutral');
  });
});

describe('spriteFor', () => {
  const happy = '0f8fad5b-d9cb-469f-a165-70867728950e.png';
  const neutral = '1f8fad5b-d9cb-469f-a165-70867728950e.webp';
  it('falls back to the neutral sprite, then null', () => {
    const sprites: PaSprites = { happy, neutral };
    expect(spriteFor(sprites, 'happy')).toBe(happy);
    expect(spriteFor(sprites, 'sad')).toBe(neutral);
    expect(spriteFor({ happy }, 'sad')).toBeNull();
    expect(spriteFor({}, 'neutral')).toBeNull();
    expect(spriteFor(null, 'happy')).toBeNull();
    expect(spriteFor(undefined, 'happy')).toBeNull();
    const inherited = Object.create({ sad: happy }) as PaSprites;
    expect(spriteFor(inherited, 'sad')).toBeNull();
  });
});
