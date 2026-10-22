import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { CheckboxGroup } from './Field';

const options = [
  { value: 'a', label: '가' },
  { value: 'b', label: '나' },
];

let root: Root | undefined;
let host: HTMLElement | undefined;

async function render(ui: React.ReactNode) {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root!.render(ui));
  return host;
}

afterEach(async () => {
  await act(async () => root?.unmount());
  host?.remove();
  root = undefined;
  host = undefined;
});

describe('CheckboxGroup 안내 문구 접근성 연결', () => {
  it('안내가 있는 그룹은 fieldset이 안내 문구를 설명으로 가리키고, 없는 그룹은 aria-describedby를 만들지 않는다', async () => {
    const view = await render(
      <>
        <CheckboxGroup legend="안내 있음" options={options} value={['a']} onChange={() => {}} hint="최대 3개까지 선택할 수 있어요." />
        <CheckboxGroup legend="안내 없음" options={options} value={[]} onChange={() => {}} />
      </>,
    );
    const fieldsets = [...view.querySelectorAll('fieldset')];
    expect(fieldsets).toHaveLength(2);
    const [withHint, withoutHint] = fieldsets;
    expect(withHint.querySelector('legend')!.textContent).toBe('안내 있음');
    expect(withoutHint.querySelector('legend')!.textContent).toBe('안내 없음');

    const hintId = withHint.getAttribute('aria-describedby');
    expect(hintId).toBeTruthy();
    const hint = view.querySelector(`[id="${hintId}"]`);
    expect(hint?.textContent).toBe('최대 3개까지 선택할 수 있어요.');
    expect(withHint.contains(hint)).toBe(true);

    expect(withoutHint.hasAttribute('aria-describedby')).toBe(false);
    expect(withoutHint.querySelector('p')).toBeNull();
  });

  it('안내가 있는 그룹이 여러 개여도 안내 ID가 서로 겹치지 않고 각자 자기 안내를 가리킨다', async () => {
    const view = await render(
      <>
        <CheckboxGroup legend="첫째" options={options} value={[]} onChange={() => {}} hint="첫째 안내" />
        <CheckboxGroup legend="둘째" options={options} value={[]} onChange={() => {}} hint="둘째 안내" />
        <CheckboxGroup legend="셋째" options={options} value={[]} onChange={() => {}} hint="셋째 안내" />
      </>,
    );
    const fieldsets = [...view.querySelectorAll('fieldset')];
    expect(fieldsets).toHaveLength(3);
    const ids = fieldsets.map((fieldset) => fieldset.getAttribute('aria-describedby'));
    expect(ids.every(Boolean)).toBe(true);
    expect(new Set(ids).size).toBe(3);
    fieldsets.forEach((fieldset, index) => {
      expect(view.querySelectorAll(`[id="${ids[index]}"]`)).toHaveLength(1);
      expect(fieldset.querySelector(`[id="${ids[index]}"]`)?.textContent).toBe(['첫째 안내', '둘째 안내', '셋째 안내'][index]);
    });
  });
});
