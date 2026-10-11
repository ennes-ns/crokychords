/** Tiny DOM helpers; the app uses no UI framework. */

export type Child = Node | string | number | null | undefined | false;

export interface ElementOptions<K extends keyof HTMLElementTagNameMap> {
  class?: string;
  /** Element properties (value, disabled, onclick, ...). */
  props?: Partial<HTMLElementTagNameMap[K]>;
  /** Attributes set with setAttribute (aria-*, data-*, title, type, ...). */
  attrs?: Record<string, string>;
  /** CSS properties, including custom properties such as '--hue'. */
  style?: Record<string, string>;
}

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  options: ElementOptions<K> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (options.class !== undefined) el.className = options.class;
  if (options.props !== undefined) Object.assign(el, options.props);
  for (const [name, value] of Object.entries(options.attrs ?? {})) el.setAttribute(name, value);
  for (const [name, value] of Object.entries(options.style ?? {}))
    el.style.setProperty(name, value);
  append(el, ...children);
  return el;
}

export function append(parent: Node, ...children: Child[]): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    parent.appendChild(typeof child === 'object' ? child : document.createTextNode(String(child)));
  }
}

/** Replace all children of `parent`. */
export function replaceChildren(parent: Element, ...children: Child[]): void {
  parent.replaceChildren();
  append(parent, ...children);
}

export function option(value: string, label: string, selected = false): HTMLOptionElement {
  return h('option', { props: { value, selected } }, label);
}

/** True when keyboard input should go to a form control instead of the app shortcuts. */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  if (target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return true;
  if (target instanceof HTMLInputElement) {
    return !['checkbox', 'radio', 'button', 'range'].includes(target.type);
  }
  return false;
}
