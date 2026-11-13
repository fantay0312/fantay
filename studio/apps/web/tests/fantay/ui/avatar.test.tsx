// @vitest-environment jsdom
// SPDX-License-Identifier: Apache-2.0
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { I18nProvider } from '../../../src/i18n';
import { Avatar, AvatarStack, initials } from '../../../src/fantay/ui/avatar';

afterEach(cleanup);

describe('initials', () => {
  it('takes the first character of a CJK name', () => {
    expect(initials('张三')).toBe('张');
    expect(initials('  李四 ')).toBe('李');
    expect(initials('山田太郎')).toBe('山');
    expect(initials('김민수')).toBe('김');
  });

  it('takes first and last initials of a Latin name, or two letters of one word', () => {
    expect(initials('Ada Lovelace')).toBe('AL');
    expect(initials('Grace Brewster Hopper')).toBe('GH');
    expect(initials('turing')).toBe('TU');
    expect(initials('')).toBe('·');
    expect(initials(undefined)).toBe('·');
  });
});

describe('Avatar', () => {
  it('is an image named by the person with a tinted disc', () => {
    render(<Avatar name="Ada Lovelace" color="var(--brand)" />);
    const avatar = screen.getByRole('img', { name: 'Ada Lovelace' });
    expect(avatar).toHaveTextContent('AL');
    expect(avatar.style.width).toBe('24px');
    expect(avatar.className).toContain('text-micro');
    expect(avatar.getAttribute('style')).toContain('color-mix(in srgb, var(--brand) 22%, var(--surface))');
  });

  it('never drops a CJK initial below the 12px label step', () => {
    render(<Avatar name="张三" size={24} />);
    const avatar = screen.getByRole('img', { name: '张三' });
    expect(avatar.className).toContain('text-label');
    expect(avatar.className).not.toContain('text-micro');
  });

  it('uses the icon for agents and the ink tone without a collar', () => {
    render(
      <>
        <Avatar name="Agent" kind="agent" icon={<span data-testid="mark">✦</span>} />
        <Avatar name="Me" tone="ink" size={40} />
      </>,
    );
    expect(screen.getByTestId('mark')).toBeInTheDocument();
    const me = screen.getByRole('img', { name: 'Me' });
    expect(me.className).toContain('bg-ink');
    expect(me.className).toContain('shadow-none');
    expect(me.className).toContain('text-body');
  });
});

describe('AvatarStack', () => {
  const people = [
    { id: '1', name: '张三' },
    { id: '2', name: 'Ada Lovelace' },
    { id: '3', name: 'Grace Hopper' },
    { id: '4', name: 'Alan Turing' },
    { id: '5', name: 'Linus' },
  ];

  it('shows max faces and a localized overflow disc', () => {
    render(<AvatarStack people={people} max={3} />);
    expect(screen.getAllByRole('img')).toHaveLength(4);
    const more = screen.getByRole('img', { name: '2 more' });
    expect(more).toHaveTextContent('+2');
    expect(more).toHaveAttribute('title', '2 more');
  });

  it('localizes the overflow label (zh-CN)', () => {
    render(
      <I18nProvider initial="zh-CN">
        <AvatarStack people={people} max={4} />
      </I18nProvider>,
    );
    expect(screen.getByRole('img', { name: '另外 1 人' })).toHaveTextContent('+1');
  });

  it('renders nothing for an empty list', () => {
    const { container } = render(<AvatarStack people={[]} />);
    expect(container).toBeEmptyDOMElement();
  });
});
