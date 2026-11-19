import { createElement } from 'react';
import { resolveToolPurposeIcon, toolPurposeNodes, type ToolPurposeInput } from './tool-icons/resolve';

/** Bundled, brand-free geometry. Never load a supplier logo or remote URL. */
export function ToolPurposeIcon({ tool, size = 22 }: { tool: ToolPurposeInput; size?: number }) {
  const name = resolveToolPurposeIcon(tool);
  return <svg data-tool-icon={name} aria-hidden="true" focusable="false" width={size} height={size} viewBox="0 0 24 24"
    fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flex: 'none' }}>
    {toolPurposeNodes[name].map(([tag, attributes], index) => createElement(tag, { ...attributes, key: index }))}
  </svg>;
}
