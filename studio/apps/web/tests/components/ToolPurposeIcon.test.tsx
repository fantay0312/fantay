// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { ToolPurposeIcon } from '../../src/components/tokentosea/ToolPurposeIcon';

afterEach(cleanup);

describe('tool purpose icons', () => {
  it('uses a known public identity even when the category and display name are generic', () => {
    const { container } = render(<ToolPurposeIcon tool={{ id: 'tool_6bce09133ba9995a9d7e9b08abcda670', name: '智能处理 6BCE', category: 'ai' }} />);
    expect(container.querySelector('svg')?.getAttribute('data-tool-icon')).toBe('Car');
    expect(container.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toBe('');
  });

  it('updates purpose when selection changes and safely handles unknown tools', () => {
    const { container, rerender } = render(<ToolPurposeIcon tool={{ name: '空气质量' }} />);
    expect(container.querySelector('svg')?.getAttribute('data-tool-icon')).toBe('Wind');
    rerender(<ToolPurposeIcon tool={{ name: '酒店研究' }} size={28} />);
    expect(container.querySelector('svg')?.getAttribute('data-tool-icon')).toBe('Hotel');
    expect(container.querySelector('svg')?.getAttribute('width')).toBe('28');
    rerender(<ToolPurposeIcon tool={{ name: '', category: 'constructor' }} />);
    expect(container.querySelector('svg')?.getAttribute('data-tool-icon')).toBe('Wrench');
  });
});
