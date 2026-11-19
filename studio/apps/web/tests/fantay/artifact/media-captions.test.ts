// SPDX-License-Identifier: AGPL-3.0-only
// Subtitles next to a film: which file belongs to it, and how WebVTT and SubRip are read.
import { describe, expect, it } from 'vitest';

import { captionAt, captionFileNames, parseCaptions } from '../../../src/fantay/artifact/viewers/media/captions';

const VTT = `WEBVTT - 产品演示

NOTE 这一段是备注，不是字幕

STYLE
::cue { color: yellow }

intro
00:00:01.000 --> 00:00:04.000 line:90% align:center
<v 旁白>欢迎使用 <b>Fantay</b></v>
第二行 &amp; 更多

00:05.500 --> 00:08.000
右侧是工作区
`;

const SRT = `1
00:00:01,000 --> 00:00:03,500
{\\an8}第一句<i>字幕</i>

2
00:00:03,000 --> 00:00:06,000
第二句字幕

3
00:01:02,250 --> 00:01:04,000
一分钟以后
`;

describe('subtitle files', () => {
  it('belong to the film with the same name in the same folder, vtt first', () => {
    expect(captionFileNames('media/产品演示-1080p.mp4')).toEqual(['media/产品演示-1080p.vtt', 'media/产品演示-1080p.srt']);
    expect(captionFileNames('clip.final.webm')).toEqual(['clip.final.vtt', 'clip.final.srt']);
  });

  it('keep a folder with a dot and a name without an extension apart', () => {
    expect(captionFileNames('v1.2/clip')).toEqual(['v1.2/clip.vtt', 'v1.2/clip.srt']);
    expect(captionFileNames('media/.hidden')).toEqual(['media/.hidden.vtt', 'media/.hidden.srt']);
  });
});

describe('reading subtitles', () => {
  it('reads WebVTT: skips the header, notes and styles, drops markup and settings', () => {
    expect(parseCaptions(VTT)).toEqual([
      { start: 1, end: 4, text: '欢迎使用 Fantay\n第二行 & 更多' },
      { start: 5.5, end: 8, text: '右侧是工作区' },
    ]);
  });

  it('reads SubRip: comma fractions, counters, position overrides', () => {
    expect(parseCaptions(SRT)).toEqual([
      { start: 1, end: 3.5, text: '第一句字幕' },
      { start: 3, end: 6, text: '第二句字幕' },
      { start: 62.25, end: 64, text: '一分钟以后' },
    ]);
  });

  it('accepts Windows line ends and a byte order mark', () => {
    const source = '﻿WEBVTT\r\n\r\n00:00:00.000 --> 00:00:02.000\r\n你好\r\n';
    expect(parseCaptions(source)).toEqual([{ start: 0, end: 2, text: '你好' }]);
  });

  it('never keeps markup: a script tag in a cue is only its words', () => {
    const source = 'WEBVTT\n\n00:00.000 --> 00:02.000\n<script>alert(1)</script>安全 <img src=x onerror=1>';
    expect(parseCaptions(source)).toEqual([{ start: 0, end: 2, text: 'alert(1)安全' }]);
  });

  it('drops cues with no words or no length, and text that is not subtitles', () => {
    expect(parseCaptions('WEBVTT\n\n00:02.000 --> 00:01.000\n倒着的\n\n00:03.000 --> 00:04.000\n<i></i>\n')).toEqual([]);
    expect(parseCaptions('这只是一段普通文字 --> 没有时间')).toEqual([]);
    expect(parseCaptions('')).toEqual([]);
  });

  it('sorts cues by their start', () => {
    const source = 'WEBVTT\n\n00:05.000 --> 00:06.000\n后\n\n00:01.000 --> 00:02.000\n先\n';
    expect(parseCaptions(source).map((cue) => cue.text)).toEqual(['先', '后']);
  });
});

describe('the line on screen', () => {
  const cues = parseCaptions(SRT);

  it('is the cue that covers the time', () => {
    expect(captionAt(cues, 1.2)).toBe('第一句字幕');
    expect(captionAt(cues, 63)).toBe('一分钟以后');
  });

  it('stacks cues that overlap', () => {
    expect(captionAt(cues, 3.2)).toBe('第一句字幕\n第二句字幕');
  });

  it('is empty between cues, before the first and at a cue’s end', () => {
    expect(captionAt(cues, 0.5)).toBe('');
    expect(captionAt(cues, 30)).toBe('');
    expect(captionAt(cues, 6)).toBe('');
    expect(captionAt([], 3)).toBe('');
  });
});
