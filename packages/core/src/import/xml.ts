/**
 * A minimal XML reader for MusicXML (docs/specs/import-v1.md §A2): elements, attributes, text and
 * the five predefined plus numeric entities. Comments, processing instructions, the DOCTYPE and
 * CDATA sections are handled; namespaces are kept in the names. Not a validating parser: it reads
 * well-formed files and throws XmlError on anything it cannot follow.
 */

export interface XmlElement {
  name: string;
  attrs: Record<string, string>;
  children: XmlElement[];
  /** The element's own text (child elements' text not included), entities decoded. */
  text: string;
}

export class XmlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'XmlError';
  }
}

const NAMED: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

function decodeEntities(text: string): string {
  if (!text.includes('&')) return text;
  return text.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[A-Za-z][A-Za-z0-9]*);/g, (whole, body: string) => {
    if (body.startsWith('#')) {
      const cp = body[1] === 'x' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isInteger(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : whole;
    }
    return NAMED[body] ?? whole;
  });
}

const NAME = /^[A-Za-z_:][-A-Za-z0-9_:.]*/;
const ATTR = /^\s+([A-Za-z_:][-A-Za-z0-9_:.]*)\s*=\s*("([^"]*)"|'([^']*)')/;

/** Most elements one document may have (a guard against pathological input). */
export const MAX_XML_ELEMENTS = 2_000_000;

/** Parse a document and return its root element. */
export function parseXml(source: string): XmlElement {
  const text = source.charCodeAt(0) === 0xfeff ? source.slice(1) : source;
  const stack: XmlElement[] = [];
  let root: XmlElement | null = null;
  let count = 0;
  let pos = 0;
  const skipPast = (end: string, what: string): void => {
    const at = text.indexOf(end, pos);
    if (at < 0) throw new XmlError(`unterminated ${what}`);
    pos = at + end.length;
  };
  while (pos < text.length) {
    const lt = text.indexOf('<', pos);
    const chunk = lt < 0 ? text.slice(pos) : text.slice(pos, lt);
    const top = stack.at(-1);
    if (chunk !== '') {
      if (top !== undefined) top.text += decodeEntities(chunk);
      else if (chunk.trim() !== '') throw new XmlError('text outside the root element');
    }
    if (lt < 0) break;
    pos = lt;
    if (text.startsWith('<!--', pos)) {
      skipPast('-->', 'comment');
    } else if (text.startsWith('<![CDATA[', pos)) {
      const end = text.indexOf(']]>', pos);
      if (end < 0) throw new XmlError('unterminated CDATA section');
      if (top !== undefined) top.text += text.slice(pos + 9, end);
      pos = end + 3;
    } else if (text.startsWith('<?', pos)) {
      skipPast('?>', 'processing instruction');
    } else if (text.startsWith('<!', pos)) {
      // DOCTYPE, possibly with an internal subset in brackets.
      let depth = 0;
      let i = pos + 2;
      for (; i < text.length; i++) {
        const ch = text[i];
        if (ch === '[') depth++;
        else if (ch === ']') depth--;
        else if (ch === '>' && depth <= 0) break;
      }
      if (i >= text.length) throw new XmlError('unterminated declaration');
      pos = i + 1;
    } else if (text.startsWith('</', pos)) {
      const m = NAME.exec(text.slice(pos + 2, pos + 2 + 256));
      const name = m?.[0];
      const close = text.indexOf('>', pos);
      if (name === undefined || close < 0) throw new XmlError('malformed closing tag');
      const open = stack.pop();
      if (open === undefined || open.name !== name) {
        throw new XmlError(`closing tag </${name}> does not match <${open?.name ?? ''}>`);
      }
      pos = close + 1;
    } else {
      const m = NAME.exec(text.slice(pos + 1, pos + 1 + 256));
      const name = m?.[0];
      if (name === undefined) throw new XmlError('malformed tag');
      pos += 1 + name.length;
      const element: XmlElement = { name, attrs: {}, children: [], text: '' };
      for (;;) {
        const rest = text.slice(pos, pos + 4096);
        const attr = ATTR.exec(rest);
        if (attr === null) break;
        const [whole, attrName = '', , dq, sq] = attr;
        element.attrs[attrName] = decodeEntities(dq ?? sq ?? '');
        pos += whole.length;
      }
      while (pos < text.length && /\s/.test(text.charAt(pos))) pos++;
      let selfClosing = false;
      if (text.startsWith('/>', pos)) {
        selfClosing = true;
        pos += 2;
      } else if (text.charAt(pos) === '>') {
        pos += 1;
      } else {
        throw new XmlError(`malformed tag <${name}>`);
      }
      if (++count > MAX_XML_ELEMENTS) throw new XmlError('too many elements');
      if (top !== undefined) top.children.push(element);
      else if (root === null) root = element;
      else throw new XmlError('more than one root element');
      if (!selfClosing) stack.push(element);
    }
  }
  if (stack.length > 0) throw new XmlError(`unclosed element <${stack.at(-1)?.name ?? ''}>`);
  if (root === null) throw new XmlError('no root element');
  return root;
}

/** The first child named `name`. */
export function child(element: XmlElement | undefined, name: string): XmlElement | undefined {
  return element?.children.find((c) => c.name === name);
}

/** Every child named `name`. */
export function children(element: XmlElement | undefined, name: string): XmlElement[] {
  return element?.children.filter((c) => c.name === name) ?? [];
}

/** Trimmed text of the child named `name` (a path such as 'pitch/step' walks down). */
export function childText(element: XmlElement | undefined, path: string): string | undefined {
  let node = element;
  for (const part of path.split('/')) node = child(node, part);
  return node?.text.trim();
}

/** The child's text as a finite number, else undefined. */
export function childNumber(element: XmlElement | undefined, path: string): number | undefined {
  const text = childText(element, path);
  if (text === undefined || text === '') return undefined;
  const n = Number(text);
  return Number.isFinite(n) ? n : undefined;
}
