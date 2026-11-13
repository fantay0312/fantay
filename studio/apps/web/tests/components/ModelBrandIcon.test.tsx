// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { existsSync } from 'node:fs';
import { URL as NodeURL } from 'node:url';
import { LOCAL_MODEL_ICON_IDS, ModelBrandIcon, resolveModelBrandIcon } from '../../src/components/tokentosea/ModelBrandIcon';

afterEach(cleanup);
describe('local model brand icons', () => {
  it('uses explicit model brands before relay providers and keeps TypeSafe distinct', () => {
    expect(resolveModelBrandIcon({ brand: 'typesafe', provider: 'official' })?.src).toBe('/model-brand-icons/typesafe.svg');
    expect(resolveModelBrandIcon({ brand: 'deepseek', provider: 'relay' })?.src).toBe('/model-brand-icons/deepseek-color.svg');
    expect(resolveModelBrandIcon({ brand: 'wan', provider: 'qwen' })?.src).toBe('/model-brand-icons/wan.svg');
    expect(resolveModelBrandIcon({ icon: 'openai', iconMono: false })?.mono).toBe(true);
  });
  it('does not turn remote URLs, unknown brands or path traversal into image requests', () => {
    expect(resolveModelBrandIcon({ brand: 'other', icon: 'deepseek-color' })).toBeNull();
    expect(resolveModelBrandIcon({ icon: 'https://example.test/image.svg' })).toBeNull();
    expect(resolveModelBrandIcon({ icon: '../secret', brand: 'unknown' })).toBeNull();
    for (const id of LOCAL_MODEL_ICON_IDS) expect(existsSync(new NodeURL(`../../public/model-brand-icons/${id}.svg`, import.meta.url)), id).toBe(true);
  });
  it('falls back cleanly when a local color image cannot load', () => {
    const { container } = render(<ModelBrandIcon model={{ brand: 'typesafe' }} fallback="T" />);
    fireEvent.error(container.querySelector('img')!);
    expect(container).toHaveTextContent('T');
    expect(container.querySelector('img')).toBeNull();
  });
});
