import type { XmlValidator } from './xlsxPatch';

/**
 * 브라우저 내장 XML 파서(DOMParser)로 같은 XML을 따로 검사한다. 직접 만든 파서 하나로만 "올바르다"고 판단하지 않기 위해서다.
 * DOMParser가 없는 환경(테스트 node 등)에서는 undefined를 돌려준다.
 */
export function createDomXmlValidator(): XmlValidator | undefined {
  if (typeof DOMParser === 'undefined') return undefined;
  const parser = new DOMParser();
  return (xml) => {
    const document = parser.parseFromString(xml, 'application/xml');
    // 브라우저마다 오류를 parsererror 요소로 알린다(OOXML에는 이 이름의 요소가 없다).
    return document.getElementsByTagNameNS('*', 'parsererror').length > 0 ? '브라우저 XML 형식 검사를 통과하지 못했어요.' : undefined;
  };
}
