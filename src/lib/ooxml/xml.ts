/*
 * OOXML 파트를 읽기 위한 최소 XML 파서. 요소마다 원문 위치(offset)를 남겨, 바꿀 부분만 문자열로 교체하고
 * 나머지 바이트(namespace 선언 · XML 선언 · 속성 표기 · 공백)는 원본 그대로 둘 수 있게 한다.
 * DTD · 엔티티 선언은 받지 않는다(외부 참조 · 엔티티 확장 공격을 막는다).
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

const NAME_CHAR = /[^\s=/>"'<]/;

const namedEntities: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

/** XML 1.0에서 허용하는 문자만 있는가 */
export function isXmlSafeText(text: string): boolean {
  for (const char of text) {
    const code = char.codePointAt(0)!;
    const allowed = code === 0x9 || code === 0xa || code === 0xd || (code >= 0x20 && code <= 0xd7ff) || (code >= 0xe000 && code <= 0xfffd) || (code >= 0x10000 && code <= 0x10ffff);
    if (!allowed) return false;
  }
  return true;
}

export function decodeEntities(raw: string): string {
  return raw.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[A-Za-z]+);|&/g, (_match, entity: string | undefined) => {
    if (!entity) throw new XmlParseError('이스케이프되지 않은 & 문자가 있어요.');
    if (entity.startsWith('#x')) return String.fromCodePoint(Number.parseInt(entity.slice(2), 16));
    if (entity.startsWith('#')) return String.fromCodePoint(Number.parseInt(entity.slice(1), 10));
    const value = namedEntities[entity];
    if (value === undefined) throw new XmlParseError(`정의되지 않은 엔티티 &${entity};`);
    return value;
  });
}

export function escapeXmlText(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function escapeXmlAttribute(text: string): string {
  return escapeXmlText(text).replace(/"/g, '&quot;');
}

/** 문서 전체를 읽어 최상위 요소를 돌려준다. 잘못된 XML이면 XmlParseError를 던진다. */
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

  const pushText = (text: string) => {
    const parent = stack[stack.length - 1];
    if (!parent) {
      if (text.trim() !== '') fail('최상위 요소 밖에 텍스트가 있어요.');
      return;
    }
    parent.children.push({ kind: 'text', text });
  };

  while (index < source.length) {
    const lt = source.indexOf('<', index);
    if (lt < 0) {
      pushText(decodeEntities(source.slice(index)));
      break;
    }
    if (lt > index) pushText(decodeEntities(source.slice(index, lt)));
    index = lt;

    if (source.startsWith('<!--', index)) {
      index = expect('-->', index + 4, '주석이 닫히지 않았어요.') + 3;
      continue;
    }
    if (source.startsWith('<![CDATA[', index)) {
      const close = expect(']]>', index + 9, 'CDATA가 닫히지 않았어요.');
      if (!stack.length) fail('최상위 요소 밖에 CDATA가 있어요.');
      pushText(source.slice(index + 9, close));
      index = close + 3;
      continue;
    }
    if (source.startsWith('<?', index)) {
      index = expect('?>', index + 2, '처리 명령이 닫히지 않았어요.') + 2;
      continue;
    }
    if (source.startsWith('<!', index)) fail('DTD · 엔티티 선언은 지원하지 않아요.');

    if (source.startsWith('</', index)) {
      const close = expect('>', index + 2, '종료 태그가 닫히지 않았어요.');
      const name = source.slice(index + 2, close).trim();
      const open = stack.pop();
      if (!open || open.name !== name) fail(`종료 태그 </${name}>가 시작 태그와 맞지 않아요.`);
      open!.closeStart = index;
      open!.end = close + 1;
      index = close + 1;
      continue;
    }

    // 시작 태그
    const start = index;
    index += 1;
    let nameEnd = index;
    while (nameEnd < source.length && NAME_CHAR.test(source[nameEnd])) nameEnd += 1;
    const name = source.slice(index, nameEnd);
    if (!name) fail('요소 이름이 없어요.');
    index = nameEnd;

    const attributes: XmlAttribute[] = [];
    let selfClosing = false;
    for (;;) {
      while (index < source.length && /\s/.test(source[index])) index += 1;
      if (index >= source.length) fail(`<${name}> 시작 태그가 닫히지 않았어요.`);
      if (source[index] === '>') {
        index += 1;
        break;
      }
      if (source.startsWith('/>', index)) {
        selfClosing = true;
        index += 2;
        break;
      }
      const rawStart = index;
      let attrEnd = index;
      while (attrEnd < source.length && NAME_CHAR.test(source[attrEnd])) attrEnd += 1;
      const attrName = source.slice(index, attrEnd);
      if (!attrName) fail(`<${name}>의 속성을 읽을 수 없어요.`);
      index = attrEnd;
      while (/\s/.test(source[index] ?? '')) index += 1;
      if (source[index] !== '=') fail(`${attrName} 속성에 값이 없어요.`);
      index += 1;
      while (/\s/.test(source[index] ?? '')) index += 1;
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
    const namespaces = new Map(parent?.namespaces ?? []);
    for (const attribute of attributes) {
      if (attribute.name === 'xmlns') namespaces.set('', attribute.value);
      else if (attribute.name.startsWith('xmlns:')) namespaces.set(attribute.name.slice(6), attribute.value);
    }
    const colon = name.indexOf(':');
    const element: XmlElement = {
      kind: 'element',
      name,
      prefix: colon < 0 ? '' : name.slice(0, colon),
      localName: colon < 0 ? name : name.slice(colon + 1),
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

export function descendants(element: XmlElement, localName: string): XmlElement[] {
  const found: XmlElement[] = [];
  for (const child of childElements(element)) {
    if (child.localName === localName) found.push(child);
    found.push(...descendants(child, localName));
  }
  return found;
}
