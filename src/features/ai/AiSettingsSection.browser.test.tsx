import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import '@/styles/tokens.css';
import '@/styles/base.css';
import { AI_ACCESS_CODE_STORAGE_KEY, AI_PROVIDER_STORAGE_KEY } from './aiSettings';
import { AiSettingsSection } from './AiSettingsSection';

/* 설정 화면의 AI 섹션: 무료 Groq 기본값 · OpenAI 비활성 · 접근 코드(sessionStorage 전용, API 키 입력 아님) · 390px */

const CODE = 'browser-settings-access-code-0123456789';
let root: Root | undefined;
let container: HTMLDivElement | undefined;

async function mount() {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root!.render(<AiSettingsSection />));
  return container;
}

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  root = container = undefined;
  sessionStorage.clear();
  localStorage.clear();
  await page.viewport(1280, 900);
});

const radios = () => [...document.querySelectorAll<HTMLInputElement>('input[type="radio"][name="ai-provider"]')];
const codeInput = () => page.getByLabelText('접근 코드').element() as HTMLInputElement;

describe('설정: AI 초안', () => {
  it('무료 Groq가 기본으로 선택돼 있고 OpenAI는 선택할 수 없다', async () => {
    const view = await mount();
    const [groq, openai] = radios();
    expect(groq.value).toBe('groq');
    expect(groq.checked).toBe(true);
    expect(groq.disabled).toBe(false);
    expect(openai.value).toBe('openai');
    expect(openai.checked).toBe(false);
    expect(openai.disabled).toBe(true);
    expect(view.textContent).toContain('Groq · GPT-OSS 120B');
    expect(view.textContent).toContain('무료 AI · 기본값');
    expect(view.textContent).toContain('OpenAI');
    expect(view.textContent).toContain('유료 AI · 추후 활성화');
    // 비활성 라디오는 클릭해도 선택되지 않고 저장되지 않는다.
    await userEvent.click(openai.closest('label')!, { force: true });
    expect(radios()[0].checked).toBe(true);
    expect(localStorage.getItem(AI_PROVIDER_STORAGE_KEY)).toBeNull();
  });

  it('API 키를 입력받는 칸이 없고, 접근 코드 칸은 가려진 입력이며 API 키가 아니라고 안내한다', async () => {
    const view = await mount();
    const inputs = [...view.querySelectorAll('input:not([type="radio"])')];
    expect(inputs).toHaveLength(1);
    expect(codeInput().type).toBe('password');
    expect(codeInput().autocomplete).toBe('off');
    expect(view.textContent).toContain('Groq · OpenAI API 키가 아니에요');
    expect(view.textContent).toContain('이 화면에서 입력하거나 저장하지 않아요');
    expect(view.textContent).toContain('sessionStorage');
    expect(view.textContent).toContain('LOOMA_AI_ACCESS_CODE');
    expect(view.textContent).toContain('유료 AI로 넘어가지 않고');
  });

  it('접근 코드를 저장하면 sessionStorage에만 들어가고 화면에 다시 드러나지 않는다', async () => {
    const view = await mount();
    expect(view.textContent).toContain('접근 코드가 없어요');
    await userEvent.fill(codeInput(), CODE);
    await userEvent.click(page.getByRole('button', { name: '저장' }));
    await expect.poll(() => sessionStorage.getItem(AI_ACCESS_CODE_STORAGE_KEY)).toBe(CODE);
    await expect.poll(() => view.textContent).toContain('접근 코드가 저장돼 있어요');
    expect(codeInput().value).toBe('');
    expect(view.textContent).not.toContain(CODE);
    expect(localStorage.length).toBe(0);
    expect(JSON.stringify({ ...localStorage })).not.toContain(CODE);
    expect(location.href).not.toContain(CODE);
  });

  it('너무 짧은 접근 코드는 저장하지 않고 이유를 알린다', async () => {
    const view = await mount();
    await userEvent.fill(codeInput(), 'short');
    await userEvent.click(page.getByRole('button', { name: '저장' }));
    await expect.poll(() => view.textContent).toContain('24자 이상이어야 해요');
    expect(sessionStorage.getItem(AI_ACCESS_CODE_STORAGE_KEY)).toBeNull();
  });

  it('지우기를 누르면 접근 코드가 사라진다', async () => {
    sessionStorage.setItem(AI_ACCESS_CODE_STORAGE_KEY, CODE);
    const view = await mount();
    await expect.poll(() => view.textContent).toContain('접근 코드가 저장돼 있어요');
    await userEvent.click(page.getByRole('button', { name: '지우기' }));
    await expect.poll(() => sessionStorage.getItem(AI_ACCESS_CODE_STORAGE_KEY)).toBeNull();
    expect(view.textContent).toContain('접근 코드를 지웠어요');
  });

  it('390px에서 가로로 넘치지 않는다', async () => {
    await page.viewport(390, 844);
    const view = await mount();
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(390);
    expect(view.scrollWidth).toBeLessThanOrEqual(390);
  });
});
