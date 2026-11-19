// SPDX-License-Identifier: AGPL-3.0-only
// Small DOM helpers of the admin console: elements, form controls, dialogs and toasts. No framework: a section is a
// function that returns nodes, and it is rebuilt after every change.
export type Child = Node | string | number | null | undefined | false | Child[];
type Props = { class?: string; onClick?: (event: MouseEvent) => void } & Record<string, unknown>;

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props?: Props | null, ...children: Child[]): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') node.className = String(value);
    else if (key === 'onClick') node.addEventListener('click', value as EventListener);
    else if (key in node && typeof value !== 'string') (node as unknown as Record<string, unknown>)[key] = value;
    else node.setAttribute(key, value === true ? '' : String(value));
  }
  append(node, children);
  return node;
}
function append(node: Node, children: Child[]): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    if (Array.isArray(child)) append(node, child);
    else node.appendChild(typeof child === 'object' ? child : document.createTextNode(String(child)));
  }
}

const dateTime = new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
const dateOnly = new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' });
export const formatTime = (at: number | null | undefined): string => (at ? dateTime.format(at) : '—');
export const formatDate = (at: number | null | undefined): string => (at ? dateOnly.format(at) : '—');

// ---- controls ----------------------------------------------------------------------------------------------------
type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';
export function button(label: string, options: { variant?: Variant; onClick?: () => void; disabled?: boolean; type?: 'button' | 'submit'; title?: string } = {}): HTMLButtonElement {
  return h('button', {
    class: `btn btn-${options.variant ?? 'secondary'}`, type: options.type ?? 'button', disabled: options.disabled ?? false,
    ...(options.title ? { title: options.title } : {}),
    ...(options.onClick ? { onClick: () => options.onClick?.() } : {}),
  }, label);
}
export function badge(text: string, tone: 'neutral' | 'good' | 'warn' | 'bad' | 'info' = 'neutral'): HTMLSpanElement {
  return h('span', { class: `badge badge-${tone}` }, text);
}
export const chips = (items: readonly string[], empty = '—'): Node =>
  items.length ? h('span', { class: 'chips' }, items.map(item => h('span', { class: 'chip' }, item))) : h('span', { class: 'muted' }, empty);

let fieldId = 0;
/** A labelled form row. `control` gets the id the label points at. */
export function field(label: string, control: HTMLElement, hint?: string): HTMLDivElement {
  const id = control.id || `f${++fieldId}`;
  if (control instanceof HTMLInputElement || control instanceof HTMLTextAreaElement || control instanceof HTMLSelectElement) control.id = id;
  return h('div', { class: 'field' },
    control.id ? h('label', { class: 'field-label', for: id }, label) : h('div', { class: 'field-label' }, label),
    control, hint ? h('p', { class: 'field-hint' }, hint) : null);
}
export function textInput(options: { value?: string; type?: string; placeholder?: string; required?: boolean; maxLength?: number; autocomplete?: string } = {}): HTMLInputElement {
  return h('input', {
    class: 'input', type: options.type ?? 'text', value: options.value ?? '', placeholder: options.placeholder ?? '',
    required: options.required ?? false, autocomplete: options.autocomplete ?? 'off', spellcheck: false,
    ...(options.maxLength ? { maxLength: options.maxLength } : {}),
  });
}
export function textArea(options: { value?: string; rows?: number; placeholder?: string; mono?: boolean } = {}): HTMLTextAreaElement {
  return h('textarea', { class: `input textarea${options.mono ? ' mono' : ''}`, rows: options.rows ?? 4, placeholder: options.placeholder ?? '', spellcheck: false }, options.value ?? '');
}
/** Equal segments across the whole row; reads back with `.value`. */
export function segmented<T extends string>(options: ReadonlyArray<{ value: T; label: string; disabled?: boolean }>, value: T, onChange?: (value: T) => void) {
  const name = `s${++fieldId}`;
  let current = value;
  const node = h('div', { class: 'segmented', role: 'radiogroup' }, options.map(option => {
    const input = h('input', { type: 'radio', name, value: option.value, checked: option.value === value, disabled: option.disabled ?? false });
    input.addEventListener('change', () => { current = option.value; onChange?.(option.value); });
    return h('label', { class: 'segment' }, input, h('span', null, option.label));
  }));
  return { node, get value(): T { return current; } };
}
/** A column of checkboxes with an optional description each; reads back with `.values`. */
export function checkList(options: ReadonlyArray<{ value: string; label: string; hint?: string }>, selected: readonly string[], disabled = false) {
  const inputs = options.map(option => ({ option, input: h('input', { type: 'checkbox', checked: selected.includes(option.value), disabled }) }));
  const node = h('div', { class: 'checks' }, inputs.map(({ option, input }) =>
    h('label', { class: 'check' }, input, h('span', { class: 'check-text' }, h('span', null, option.label), option.hint ? h('small', null, option.hint) : null))));
  return { node, get values(): string[] { return inputs.filter(item => item.input.checked).map(item => item.option.value); } };
}
/** A switch row: label and explanation on the left, the switch on the right. */
export function toggle(label: string, hint: string, checked: boolean, disabled = false) {
  const input = h('input', { type: 'checkbox', class: 'switch', role: 'switch', checked, disabled });
  const node = h('label', { class: 'row toggle-row' }, h('span', { class: 'row-main' }, h('strong', null, label), h('small', null, hint)), input);
  return { node, get checked(): boolean { return input.checked; } };
}
export function select<T extends string>(options: ReadonlyArray<{ value: T; label: string }>, value: T): HTMLSelectElement {
  return h('select', { class: 'input' }, options.map(option => h('option', { value: option.value, selected: option.value === value }, option.label)));
}

// ---- layout pieces -----------------------------------------------------------------------------------------------
/** A titled block of rows separated by hairlines. */
export function group(title: string | null, ...rows: Child[]): HTMLElement {
  return h('section', { class: 'group' }, title ? h('h2', { class: 'group-title' }, title) : null, h('div', { class: 'group-body' }, rows));
}
export function row(label: string, value: Child, action?: Child): HTMLDivElement {
  return h('div', { class: 'row' }, h('span', { class: 'row-label' }, label), h('span', { class: 'row-value' }, value), action ? h('span', { class: 'row-action' }, action) : null);
}
export const empty = (text: string): HTMLElement => h('p', { class: 'empty' }, text);
export const note = (text: string, tone: 'plain' | 'warn' = 'plain'): HTMLElement => h('p', { class: `note note-${tone}` }, text);
export interface Column<T> { title: string; cell: (item: T) => Child; width?: string; align?: 'end' }
export function table<T>(columns: ReadonlyArray<Column<T>>, items: readonly T[], emptyText: string): HTMLElement {
  if (!items.length) return empty(emptyText);
  const template = columns.map(column => column.width ?? 'minmax(0, 1fr)').join(' ');
  const line = (cells: Child[], head: boolean) => {
    const element = h('div', { class: head ? 'tr th' : 'tr', role: 'row' },
      cells.map((cell, index) => h('div', { class: `td${columns[index]?.align === 'end' ? ' td-end' : ''}`, role: head ? 'columnheader' : 'cell' }, cell)));
    // Set through the style object: the console's content security policy refuses inline style attributes.
    element.style.gridTemplateColumns = template;
    return element;
  };
  return h('div', { class: 'table', role: 'table' }, line(columns.map(column => column.title), true), items.map(item => line(columns.map(column => column.cell(item)), false)));
}

// ---- dialogs and toasts ------------------------------------------------------------------------------------------
const messageOf = (error: unknown): string => (error instanceof Error && error.message ? error.message : '操作失败，请重试');
/** A modal form. `submit` runs on 确定; the dialog closes when it resolves and shows the message when it rejects. */
export function modal(options: { title: string; body: Child; submitLabel?: string; danger?: boolean; submit?: () => Promise<void> | void; wide?: boolean }): void {
  const error = h('p', { class: 'form-error', role: 'alert', hidden: true });
  const cancel = button(options.submit ? '取消' : '关闭', { variant: 'ghost', onClick: () => dialog.close() });
  const confirm = options.submit ? button(options.submitLabel ?? '保存', { variant: options.danger ? 'danger' : 'primary', type: 'submit' }) : null;
  const form = h('form', { class: 'dialog-form', method: 'dialog', novalidate: false },
    h('h2', { class: 'dialog-title' }, options.title), h('div', { class: 'dialog-body' }, options.body), error,
    h('div', { class: 'dialog-actions' }, cancel, confirm));
  const dialog = h('dialog', { class: `dialog${options.wide ? ' dialog-wide' : ''}` }, form);
  form.addEventListener('submit', event => {
    event.preventDefault();
    if (!options.submit || !confirm || confirm.disabled) return;
    confirm.disabled = true;
    error.hidden = true;
    Promise.resolve().then(options.submit).then(() => dialog.close(), failure => {
      error.textContent = messageOf(failure);
      error.hidden = false;
      confirm.disabled = false;
    });
  });
  dialog.addEventListener('close', () => dialog.remove());
  document.body.appendChild(dialog);
  dialog.showModal();
}
export function confirmDialog(title: string, message: string, label: string, run: () => Promise<void>, danger = true): void {
  modal({ title, body: h('p', { class: 'dialog-text' }, message), submitLabel: label, danger, submit: run });
}
/** Shows a secret once, with a copy button. Closing the dialog is the only way out: nothing keeps the value. */
export function reveal(title: string, secret: string, explain: string): void {
  const value = h('code', { class: 'secret' }, secret);
  const copy = button('复制', { onClick: () => { void navigator.clipboard.writeText(secret).then(() => { copy.textContent = '已复制'; }, () => { copy.textContent = '请手动复制'; }); } });
  modal({ title, body: [h('p', { class: 'dialog-text' }, explain), h('div', { class: 'secret-row' }, value, copy)] });
}
export function toast(message: string, tone: 'good' | 'bad' = 'good'): void {
  const host = document.getElementById('toasts') ?? document.body.appendChild(h('div', { id: 'toasts', class: 'toasts', role: 'status' }));
  const item = h('div', { class: `toast toast-${tone}` }, message);
  host.appendChild(item);
  setTimeout(() => { item.classList.add('toast-out'); setTimeout(() => item.remove(), 160); }, 3600);
}
export const failed = (error: unknown): void => toast(messageOf(error), 'bad');
