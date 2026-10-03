/** 주소로 선택된 항목이 화면 밖이면 가까운 위치까지만 스크롤한다(애니메이션 없음). ref 콜백으로 쓰며 항목이 나타날 때 한 번 실행된다. */
export function revealElement(element: HTMLElement | null) {
  element?.scrollIntoView({ block: 'nearest' });
}
