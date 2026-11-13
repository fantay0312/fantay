// SPDX-License-Identifier: AGPL-3.0-only
// 工具台 › 编码转换: Base64 or URL encoding, encode or decode, chosen on one full-width control row. The result
// follows the input; Base64 goes through UTF-8 bytes, so Chinese text round-trips. The swap button feeds the
// result back as input and reverses the direction, which is the quickest way to check a round trip.
import { useId, useMemo, useState } from 'react';
import { ArrowDownUp } from 'lucide-react';

import { Icon, IconButton, Segmented, SegmentedItem } from '../../../../ui';
import type { Translate } from '../dictionary';
import { transcode, type Codec, type CodecError, type Direction } from './logic';
import { InputBlock, OutputBlock } from './parts';
import styles from './tools.module.css';

const ERROR_KEY = {
  invalidBase64: 'encode.invalidBase64',
  invalidUtf8: 'encode.invalidUtf8',
  invalidUrl: 'encode.invalidUrl',
  invalidText: 'encode.invalidText',
} as const satisfies Record<CodecError, string>;

export function createEncodeTool(t: Translate) {
  return function EncodeTool() {
    const id = useId();
    const [codec, setCodec] = useState<Codec>('base64');
    const [direction, setDirection] = useState<Direction>('encode');
    const [input, setInput] = useState('');
    const result = useMemo(() => (input ? transcode(codec, direction, input) : null), [codec, direction, input]);
    const error = result && !result.ok ? { title: t(ERROR_KEY[result.error]) } : null;
    const output = result?.ok ? result.text : '';

    const swap = () => {
      setInput(output);
      setDirection(direction === 'encode' ? 'decode' : 'encode');
    };

    return (
      <div className={styles.tool} data-testid="toolbox-encode">
        <div className={styles.controls}>
          <Segmented
            className={styles.segmented}
            aria-label={t('encode.codec')}
            value={codec}
            onValueChange={(next) => setCodec(next === 'url' ? 'url' : 'base64')}
          >
            <SegmentedItem className={styles.segment} value="base64">Base64</SegmentedItem>
            <SegmentedItem className={styles.segment} value="url">URL</SegmentedItem>
          </Segmented>
          <Segmented
            className={styles.segmented}
            aria-label={t('encode.direction')}
            value={direction}
            onValueChange={(next) => setDirection(next === 'decode' ? 'decode' : 'encode')}
          >
            <SegmentedItem className={styles.segment} value="encode">{t('encode.encode')}</SegmentedItem>
            <SegmentedItem className={styles.segment} value="decode">{t('encode.decode')}</SegmentedItem>
          </Segmented>
        </div>
        <div className={styles.split}>
          <InputBlock
            id={`${id}-input`}
            label={t('input')}
            value={input}
            onChange={setInput}
            placeholder={direction === 'encode' ? t('encode.placeholderEncode') : t('encode.placeholderDecode')}
            invalid={Boolean(error)}
            describedBy={`${id}-output-error`}
            t={t}
          />
          <OutputBlock
            id={`${id}-output`}
            label={t('result')}
            value={output}
            error={error}
            t={t}
            tools={(
              <IconButton size="sm" aria-label={t('encode.swap')} disabled={!output} onClick={swap}>
                <Icon icon={ArrowDownUp} size="sm" />
              </IconButton>
            )}
          />
        </div>
      </div>
    );
  };
}
