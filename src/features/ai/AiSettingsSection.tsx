import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { TextField } from '@/components/ui/Field';
import { SectionHeader } from '@/components/ui/SectionHeader';
import { MIN_ACCESS_CODE_LENGTH } from '@/shared/aiTestDraftContract';
import { selectableAiProviders } from './aiProviders';
import { useAiSettings } from './useAiSettings';
import styles from './AiSettingsSection.module.css';

const providerSummary: Record<string, string> = {
  groq: '무료 AI · 기본값',
  openai: '유료 AI · 추후 활성화',
};

/** AI 공급자 선택과 서버 함수 접근 코드. API 키를 입력받는 화면이 아니다. */
export function AiSettingsSection() {
  const { provider, hasAccessCode, selectProvider, saveAccessCode, removeAccessCode } = useAiSettings();
  const [code, setCode] = useState('');
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string }>();

  const save = () => {
    if (saveAccessCode(code)) {
      setCode('');
      setMessage({ tone: 'ok', text: '접근 코드를 이 탭에 저장했어요. 탭을 닫으면 지워져요.' });
    } else {
      setMessage({ tone: 'error', text: `접근 코드는 ${MIN_ACCESS_CODE_LENGTH}자 이상이어야 해요. 저장하지 못했어요.` });
    }
  };

  return (
    <section aria-labelledby="ai-title">
      <SectionHeader id="ai-title" title="AI 초안" meta={provider.tier === 'free' ? '무료 AI 사용 중' : undefined} />
      <div className={styles.body}>
        <fieldset className={styles.providers}>
          <legend className="visually-hidden">AI 공급자 선택</legend>
          {selectableAiProviders.map((item) => (
            <label key={item.id} className={`${styles.provider} ${provider.id === item.id ? styles.selected : ''} ${item.available ? '' : styles.disabled}`}>
              <input type="radio" name="ai-provider" value={item.id} checked={provider.id === item.id} disabled={!item.available} onChange={() => selectProvider(item.id)} />
              <strong>{item.name}</strong>
              <small>{providerSummary[item.id]}</small>
            </label>
          ))}
        </fieldset>
        <p className={styles.note}>
          AI 초안은 TC 초안 만들기에서 버튼을 눌렀을 때만 만들어요. 무료 한도에 닿아도 유료 AI로 넘어가지 않고, 유료 AI는 직접 선택했을 때만 쓸 수 있어요.
        </p>

        <div className={styles.access}>
          <h3 className={styles.subtitle}>AI 접근 코드</h3>
          <p className={styles.note}>
            이 앱의 AI 서버 함수를 쓰기 위한 코드예요. Groq · OpenAI API 키가 아니에요. API 키는 서버에만 있고 이 화면에서 입력하거나 저장하지 않아요.
            코드는 서버 환경변수 <code>LOOMA_AI_ACCESS_CODE</code>와 같은 값이고, {MIN_ACCESS_CODE_LENGTH}자 이상의 무작위 값을 쓰세요. 이 탭의 sessionStorage에만 저장돼요.
          </p>
          <form
            className={styles.accessForm}
            onSubmit={(event) => {
              event.preventDefault();
              save();
            }}
          >
            <TextField label="접근 코드" type="password" autoComplete="off" spellCheck={false} value={code} onChange={(event) => setCode(event.target.value)} />
            <div className={styles.actions}>
              <Button type="submit" variant="secondary" disabled={code.trim().length === 0}>
                저장
              </Button>
              <Button
                variant="ghost"
                disabled={!hasAccessCode}
                onClick={() => {
                  removeAccessCode();
                  setMessage({ tone: 'ok', text: '접근 코드를 지웠어요.' });
                }}
              >
                지우기
              </Button>
            </div>
          </form>
          <p className={hasAccessCode ? styles.status : styles.statusOff} role="status">
            {message?.tone === 'error' ? message.text : hasAccessCode ? `접근 코드가 저장돼 있어요.${message?.tone === 'ok' ? ` ${message.text}` : ''}` : (message?.text ?? '접근 코드가 없어요. 입력하기 전에는 AI 초안을 만들 수 없어요.')}
          </p>
        </div>
      </div>
    </section>
  );
}
