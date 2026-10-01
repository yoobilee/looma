/*
 * OOXML 파트를 읽기 위한 최소 XML 파서. 요소마다 원문 위치(offset)를 남겨, 바꿀 부분만 문자열로 교체하고
 * 나머지 바이트(namespace 선언 · XML 선언 · 속성 표기 · 공백)는 원본 그대로 둘 수 있게 한다.
 * 범용 파서가 아니다. 원본 파일을 고치기 전에 쓰는 문이므로, 애매하거나 잘못된 문서는 받아들이지 않는다.
 * - XML 1.0에서 허용하지 않는 문자 · 숫자 엔티티, DTD · 엔티티 선언, 잘못된 이름 · 주석 · 속성 표기, 텍스트 안의 ]]>
 * - 선언하지 않은 namespace 접두사, namespace를 풀면 같아지는 속성 이름
 * 이 파서만으로 판단하지 않도록 브라우저에서는 DOMParser 검사(domXmlValidator)를 함께 쓴다.
 */

export class XmlParseError extends Error {}

export interface XmlAttribute {
  name: string;
  /** 엔티티를 풀어 쓴 값 */
  value: string;
  /** 원문에서 `name="value"` 전체의 위치 */
  rawStart: number;
  rawEnd: number;
}

export interface XmlText {
  kind: 'text';
  text: string;
}

export interface XmlElement {
  kind: 'element';
  /** 접두사를 포함한 이름 (예: x:c) */
  name: string;
  prefix: string;
  localName: string;
  /** 요소의 namespace URI. 없으면 빈 문자열 */
  namespaceUri: string;
  attributes: XmlAttribute[];
  /** 이 요소에서 보이는 접두사 → namespace URI. 빈 문자열 키는 기본 namespace다. */
  namespaces: ReadonlyMap<string, string>;
  /** `<`의 위치 */
  start: number;
  /** 시작 태그의 `>` 다음 위치 */
  openEnd: number;
  /** 종료 태그 `</`의 위치. 빈 요소(`/>`)면 end와 같다. */
  closeStart: number;
  /** 요소 전체가 끝난 다음 위치 */
  end: number;
  selfClosing: boolean;
  children: (XmlElement | XmlText)[];
}

const XML_NS = 'http://www.w3.org/XML/1998/namespace';
const XMLNS_NS = 'http://www.w3.org/2000/xmlns/';

const NAME_START = 'A-Z_a-z\\u00C0-\\u00D6\\u00D8-\\u00F6\\u00F8-\\u02FF\\u0370-\\u037D\\u037F-\\u1FFF\\u200C-\\u200D\\u2070-\\u218F\\u2C00-\\u2FEF\\u3001-\\uD7FF\\uF900-\\uFDCF\\uFDF0-\\uFFFD';
// XML 1.0 Name 규칙의 결합 문자 범위(U+0300–U+036F)를 그대로 옮겼다. 결합 문자는 이름의 둘째 글자부터만 허용된다.
// eslint-disable-next-line no-misleading-character-class
const NC_NAME = new RegExp(`^[${NAME_START}][${NAME_START}\\-.0-9\\u00B7\\u0300-\\u036F\\u203F-\\u2040]*$`);
/** 접두사가 있으면 하나만 허용하는 namespace 이름(QName) */
const isQName = (name: string) => {
  const parts = name.split(':');
  return parts.length <= 2 && parts.every((part) => NC_NAME.test(part));
};
const isXmlWhitespace = (char: string | undefined) => char === ' ' || char === '\t' || char === '\r' || char === '\n';
/** 이름을 읽을 때 멈추는 문자 */
const NAME_END = new Set([' ', '\t', '\r', '\n', '/', '>', '=', '"', "'", '<']);

const namedEntities: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

const isXmlChar = (code: number) =>
  code === 0x9 || code === 0xa || code === 0xd || (code >= 0x20 && code <= 0xd7ff) || (code >= 0xe000 && code <= 0xfffd) || (code >= 0x10000 && code <= 0x10ffff);

/** XML 1.0에서 허용하는 문자만 있는가(짝이 맞지 않는 surrogate도 거부한다) */
export function isXmlSafeText(text: string): boolean {
  for (const char of text) if (!isXmlChar(char.codePointAt(0)!)) return false;
  return true;
}

export function decodeEntities(raw: string): string {
  return raw.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[A-Za-z]+);|&/g, (_match, entity: string | undefined) => {
    if (!entity) throw new XmlParseError('이스케이프되지 않은 & 문자가 있어요.');
    if (entity.startsWith('#')) {
      const code = entity.startsWith('#x') ? Number.parseInt(entity.slice(2), 16) : Number.parseInt(entity.slice(1), 10);
      if (!Number.isSafeInteger(code) || !isXmlChar(code)) throw new XmlParseError(`XML에서 쓸 수 없는 문자 참조 &${entity};`);
      return String.fromCodePoint(code);
    }
    const value = namedEntities[entity];
    if (value === undefined) throw new XmlParseError(`정의되지 않은 엔티티 &${entity};`);
    return value;
  });
}

export function escapeXmlText(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** 문서 전체를 읽어 최상위 요소를 돌려준다. 잘못되었거나 지원하지 않는 XML이면 XmlParseError를 던진다. */
export function parseXml(source: string): XmlElement {
  let index = 0;
  let root: XmlElement | undefined;
  const stack: XmlElement[] = [];

  const fail = (message: string): never => {
    throw new XmlParseError(`${message} (위치 ${index})`);
  };
  const expect = (token: string, from: number, message: string) => {
    const found = source.indexOf(token, from);
    if (found < 0) fail(message);
    return found;
  };

  // 문서 전체에 XML 1.0에서 쓸 수 없는 문자가 있으면 거부한다.
  for (let position = 0; position < source.length; position += 1) {
    const code = source.codePointAt(position)!;
    if (!isXmlChar(code)) {
      index = position;
      fail(`XML에서 쓸 수 없는 문자(U+${code.toString(16).toUpperCase().padStart(4, '0')})가 있어요.`);
    }
    if (code > 0xffff) position += 1;
  }

  const pushText = (raw: string) => {
    if (raw.includes(']]>')) fail('텍스트 안에 ]]>가 있어요.');
    const parent = stack[stack.length - 1];
    if (!parent) {
      if (raw.split('').some((char) => !isXmlWhitespace(char))) fail('최상위 요소 밖에 텍스트가 있어요.');
      return;
    }
    parent.children.push({ kind: 'text', text: decodeEntities(raw) });
  };

  const readName = (from: number) => {
    let end = from;
    while (end < source.length && !NAME_END.has(source[end])) end += 1;
    return { name: source.slice(from, end), end };
  };

  while (index < source.length) {
    const lt = source.indexOf('<', index);
    if (lt < 0) {
      pushText(source.slice(index));
      break;
    }
    if (lt > index) pushText(source.slice(index, lt));
    index = lt;

    if (source.startsWith('<!--', index)) {
      const close = expect('-->', index + 4, '주석이 닫히지 않았어요.');
      const content = source.slice(index + 4, close);
      if (content.includes('--') || content.endsWith('-')) fail('주석 안에 --가 있어요.');
      index = close + 3;
      continue;
    }
    if (source.startsWith('<![CDATA[', index)) {
      const close = expect(']]>', index + 9, 'CDATA가 닫히지 않았어요.');
      if (!stack.length) fail('최상위 요소 밖에 CDATA가 있어요.');
      stack[stack.length - 1].children.push({ kind: 'text', text: source.slice(index + 9, close) });
      index = close + 3;
      continue;
    }
    if (source.startsWith('<?', index)) {
      const close = expect('?>', index + 2, '처리 명령이 닫히지 않았어요.');
      const { name: target } = readName(index + 2);
      if (!NC_NAME.test(target)) fail('처리 명령 이름이 올바르지 않아요.');
      if (target.toLowerCase() === 'xml' && index !== 0) fail('XML 선언은 문서 맨 앞에만 올 수 있어요.');
      index = close + 2;
      continue;
    }
    if (source.startsWith('<!', index)) fail('DTD · 엔티티 선언은 지원하지 않아요.');

    if (source.startsWith('</', index)) {
      const close = expect('>', index + 2, '종료 태그가 닫히지 않았어요.');
      const { name, end } = readName(index + 2);
      if (!isQName(name) || source.slice(end, close).split('').some((char) => !isXmlWhitespace(char))) fail('종료 태그가 올바르지 않아요.');
      const open = stack.pop();
      if (!open || open.name !== name) fail(`종료 태그 </${name}>가 시작 태그와 맞지 않아요.`);
      open!.closeStart = index;
      open!.end = close + 1;
      index = close + 1;
      continue;
    }

    // 시작 태그
    const start = index;
    const { name, end: nameEnd } = readName(index + 1);
    if (!isQName(name)) fail(`요소 이름(${name})이 올바르지 않아요.`);
    index = nameEnd;

    const attributes: XmlAttribute[] = [];
    let selfClosing = false;
    for (;;) {
      const before = index;
      while (isXmlWhitespace(source[index])) index += 1;
      if (index >= source.length) fail(`<${name}> 시작 태그가 닫히지 않았어요.`);
      if (source[index] === '>') {
        index += 1;
        break;
      }
      if (source[index] === '/') {
        if (source[index + 1] !== '>') fail(`<${name}> 시작 태그의 /가 올바르지 않아요.`);
        selfClosing = true;
        index += 2;
        break;
      }
      // 속성 앞에는 공백이 있어야 한다.
      if (index === before) fail(`<${name}>의 속성 사이에 공백이 없어요.`);
      const rawStart = index;
      const { name: attrName, end: attrEnd } = readName(index);
      if (!isQName(attrName)) fail(`<${name}>의 속성 이름이 올바르지 않아요.`);
      index = attrEnd;
      while (isXmlWhitespace(source[index])) index += 1;
      if (source[index] !== '=') fail(`${attrName} 속성에 값이 없어요.`);
      index += 1;
      while (isXmlWhitespace(source[index])) index += 1;
      const quote = source[index];
      if (quote !== '"' && quote !== "'") fail(`${attrName} 속성 값에 따옴표가 없어요.`);
      const valueEnd = expect(quote, index + 1, `${attrName} 속성 값이 닫히지 않았어요.`);
      const rawValue = source.slice(index + 1, valueEnd);
      if (rawValue.includes('<')) fail(`${attrName} 속성 값에 < 문자가 있어요.`);
      index = valueEnd + 1;
      if (attributes.some((attribute) => attribute.name === attrName)) fail(`${attrName} 속성이 두 번 있어요.`);
      attributes.push({ name: attrName, value: decodeEntities(rawValue), rawStart, rawEnd: index });
    }

    const parent = stack[stack.length - 1];
    const namespaces = new Map(parent?.namespaces ?? [['xml', XML_NS]]);
    for (const attribute of attributes) {
      if (attribute.name === 'xmlns') {
        if (attribute.value === XML_NS || attribute.value === XMLNS_NS) fail('예약된 namespace를 기본 namespace로 쓸 수 없어요.');
        namespaces.set('', attribute.value);
      } else if (attribute.name.startsWith('xmlns:')) {
        const prefix = attribute.name.slice(6);
        if (prefix === 'xmlns' || (prefix === 'xml') !== (attribute.value === XML_NS) || attribute.value === XMLNS_NS) fail(`${attribute.name} 선언이 올바르지 않아요.`);
        if (attribute.value === '') fail(`${attribute.name} 선언 값이 비어 있어요.`);
        namespaces.set(prefix, attribute.value);
      }
    }
    const colon = name.indexOf(':');
    const prefix = colon < 0 ? '' : name.slice(0, colon);
    if (prefix === 'xmlns') fail('xmlns 접두사는 요소에 쓸 수 없어요.');
    if (prefix && !namespaces.has(prefix)) fail(`선언하지 않은 namespace 접두사 ${prefix}:가 있어요.`);
    // namespace를 풀었을 때 같은 이름이 되는 속성은 거부한다.
    const expanded = new Set<string>();
    for (const attribute of attributes) {
      if (attribute.name === 'xmlns' || attribute.name.startsWith('xmlns:')) continue;
      const attrColon = attribute.name.indexOf(':');
      const attrPrefix = attrColon < 0 ? '' : attribute.name.slice(0, attrColon);
      if (attrPrefix && !namespaces.has(attrPrefix)) fail(`선언하지 않은 namespace 접두사 ${attrPrefix}:가 있어요.`);
      const key = attrPrefix ? `${namespaces.get(attrPrefix)}|${attribute.name.slice(attrColon + 1)}` : `|${attribute.name}`;
      if (expanded.has(key)) fail(`<${name}>에 namespace를 풀면 같은 속성(${attribute.name})이 두 번 있어요.`);
      expanded.add(key);
    }

    const element: XmlElement = {
      kind: 'element',
      name,
      prefix,
      localName: colon < 0 ? name : name.slice(colon + 1),
      namespaceUri: namespaces.get(prefix) ?? '',
      attributes,
      namespaces,
      start,
      openEnd: index,
      closeStart: index,
      end: index,
      selfClosing,
      children: [],
    };
    if (parent) parent.children.push(element);
    else if (root) fail('최상위 요소가 둘 이상이에요.');
    else root = element;
    if (!selfClosing) stack.push(element);
  }

  if (stack.length > 0) throw new XmlParseError(`<${stack[stack.length - 1].name}> 요소가 닫히지 않았어요.`);
  if (!root) throw new XmlParseError('XML 요소가 없어요.');
  return root;
}

export const childElements = (element: XmlElement, localName?: string) =>
  element.children.filter((child): child is XmlElement => child.kind === 'element' && (localName === undefined || child.localName === localName));

export const firstChild = (element: XmlElement, localName: string) => childElements(element, localName)[0];

/** 접두사 없는 속성 값 */
export function attribute(element: XmlElement, name: string): string | undefined {
  return element.attributes.find((item) => item.name === name)?.value;
}

/** namespace URI 기준으로 속성을 찾는다(접두사는 파일마다 다를 수 있다). */
export function attributeNs(element: XmlElement, namespaceUris: readonly string[], localName: string): string | undefined {
  return element.attributes.find((item) => {
    const colon = item.name.indexOf(':');
    if (colon < 0 || item.name.startsWith('xmlns')) return false;
    return item.name.slice(colon + 1) === localName && namespaceUris.includes(element.namespaces.get(item.name.slice(0, colon)) ?? '');
  })?.value;
}

/** 자손 텍스트를 이어 붙인다. skip에 있는 이름의 하위 트리는 뺀다. */
export function textContent(element: XmlElement, skip: readonly string[] = []): string {
  return element.children
    .map((child) => (child.kind === 'text' ? child.text : skip.includes(child.localName) ? '' : textContent(child, skip)))
    .join('');
}
