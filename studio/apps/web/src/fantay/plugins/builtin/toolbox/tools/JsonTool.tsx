// SPDX-License-Identifier: AGPL-3.0-only
// 工具台 › JSON: the input on one side, the formatted (2-space) or minified result on the other, chosen by
// the 格式化 / 压缩 switch on the result. The result follows the input as you type; invalid JSON shows the
// parser's message and position in place of the result and leaves the input as it is.
import { useId, useMemo, useState } from 'react';

import { Segmented, SegmentedItem } from '../../../../ui';
import type { Translate } from '../dictionary';
import { transformJson, type JsonMode, type JsonResult } from './logic';
import { InputBlock, OutputBlock, type OutputError } from './parts';
import styles from './tools.module.css';

function errorOf(result: JsonResult | null, t: Translate): OutputError | null {
  if (!result || result.ok) return null;
  const title = result.line !== undefined && result.column !== undefined
    ? t('json.invalidAt', { line: result.line, column: result.column })
    : t('json.invalid');
  return { title, detail: result.message };
}

export function createJsonTool(t: Translate) {
  return function JsonTool() {
    const id = useId();
    const [input, setInput] = useState('');
    const [mode, setMode] = useState<JsonMode>('format');
    const result = useMemo(() => (input.trim() ? transformJson(input, mode) : null), [input, mode]);
    const error = errorOf(result, t);

    return (
      <div className={styles.tool} data-testid="toolbox-json">
        <div className={styles.split}>
          <InputBlock
            id={`${id}-input`}
            label={t('input')}
            value={input}
            onChange={setInput}
            placeholder={t('json.placeholder')}
            invalid={Boolean(error)}
            describedBy={`${id}-output-error`}
            t={t}
          />
          <OutputBlock
            id={`${id}-output`}
            label={t('result')}
            value={result?.ok ? result.text : ''}
            error={error}
            t={t}
            tools={(
              <Segmented
                size="sm"
                aria-label={t('json.mode')}
                value={mode}
                onValueChange={(next) => setMode(next === 'minify' ? 'minify' : 'format')}
              >
                <SegmentedItem value="format">{t('json.format')}</SegmentedItem>
                <SegmentedItem value="minify">{t('json.minify')}</SegmentedItem>
              </Segmented>
            )}
          />
        </div>
      </div>
    );
  };
}
