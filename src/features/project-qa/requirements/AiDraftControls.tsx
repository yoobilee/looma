import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Button } from '@/components/ui/Button';
import { describeAiError, AiProviderError, type AiRequest } from '@/features/ai/aiProviders';
import { useAiSettings } from '@/features/ai/useAiSettings';
import { AI_LIMITS, type AiDraftResponse } from '@/shared/aiTestDraftContract';
import styles from './AiDraftControls.module.css';

interface AiDraftControlsProps {
  /** 보낼 내용. 규칙 기반 미리보기를 계산할 수 없으면(요구사항 오류 등) undefined. */
  request: AiRequest | undefined;
  /** AI 초안이 지금 미리보기에 보이는가 */
  active: boolean;
  /** 대화상자가 저장 중이거나 끝나서 AI 호출을 막아야 하는가 */
  locked: boolean;
  onGenerated: (response: AiDraftResponse, request: AiRequest, providerName: string) => void;
  onUseRules: () => void;
}

/**
 * AI 초안 만들기. 버튼을 눌렀을 때만 한 번 호출하고(자동 호출 · 자동 재시도 없음), 보내는 내용을 먼저 보여 준다.
 * 호출 중에는 다시 누를 수 없고, 오류가 나도 다른 공급자로 바꾸지 않는다. 규칙 기반 초안은 언제든 그대로 쓸 수 있다.
 */
export function AiDraftControls({ request, active, locked, onGenerated, onUseRules }: AiDraftControlsProps) {
  const { provider, hasAccessCode, currentAccessCode } = useAiSettings();
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState('');
  // 상태 갱신 전에 두 번 눌러도 호출이 한 번만 나가도록 ref로도 막는다.
  const inFlight = useRef(false);
  const controller = useRef<AbortController>(undefined);
  useEffect(() => () => controller.current?.abort(), []);

  if (!request) return null;
  const overLimit = request.requirements.length > AI_LIMITS.maxRequirements || request.perspectives.length > AI_LIMITS.maxPerspectives;
  const blockedReason = overLimit
    ? `AI 초안은 한 번에 요구사항 ${AI_LIMITS.maxRequirements}개 · 관점 ${AI_LIMITS.maxPerspectives}개까지 만들 수 있어요. 선택을 줄여 주세요.`
    : !provider.available
      ? '선택한 AI 공급자를 지금은 쓸 수 없어요.'
      : !hasAccessCode
        ? 'AI 접근 코드가 없어요.'
        : '';

  const generate = async () => {
    if (inFlight.current || locked || blockedReason) return;
    inFlight.current = true;
    setGenerating(true);
    setError('');
    controller.current = new AbortController();
    try {
      const response = await provider.generateTestDrafts(request, { accessCode: currentAccessCode(), signal: controller.current.signal });
      onGenerated(response, request, provider.name);
    } catch (caught) {
      if (!(caught instanceof AiProviderError && caught.code === 'aborted')) setError(describeAiError(caught));
    } finally {
      inFlight.current = false;
      setGenerating(false);
    }
  };

  return (
    <section className={styles.panel} aria-label="AI 초안">
      <div className={styles.head}>
        <p className={styles.provider}>
          현재 AI · <strong>{provider.name}</strong> ({provider.tier === 'free' ? '무료' : '유료'})
        </p>
        <div className={styles.actions}>
          {active && (
            <Button variant="ghost" size="sm" disabled={generating || locked} onClick={onUseRules}>
              규칙 기반 초안으로 돌아가기
            </Button>
          )}
          <Button variant="secondary" size="sm" disabled={generating || locked || !!blockedReason} onClick={() => void generate()}>
            {generating ? 'AI가 만드는 중…' : active ? 'AI로 다시 만들기' : 'AI로 TC 초안 생성'}
          </Button>
        </div>
      </div>
      <p className={styles.scope}>
        버튼을 누르면 선택한 요구사항 {request.requirements.length}건의 ID · 기능 · 문장 · 확인 필요 여부와 테스트 관점 {request.perspectives.length}개만 외부 AI({provider.name.split(' ')[0]})로 보내요.
        산출물 파일 · 근거 위치 · 기존 TC · 다른 프로젝트 데이터는 보내지 않아요. 만든 초안은 후보일 뿐이라 적용하기 전까지 아무것도 바뀌지 않아요.
      </p>
      <div className={styles.sent}>
        <p className={styles.sentTitle}>보낼 요구사항</p>
        <ul>
          {request.requirements.map((item) => (
            <li key={item.id}>
              {item.feature} · {item.text}
              {item.needsConfirmation ? ' (확인 필요)' : ''}
            </li>
          ))}
        </ul>
      </div>
      {blockedReason && (
        <p className={styles.hint}>
          {blockedReason}
          {!hasAccessCode && !overLimit && (
            <>
              {' '}
              <Link to="/settings">설정</Link>에서 입력해 주세요.
            </>
          )}
        </p>
      )}
      <p className={styles.loading} role="status" aria-live="polite">
        {generating ? `AI가 초안을 만드는 중이에요. 최대 ${Math.round(AI_LIMITS.clientTimeoutMs / 1000)}초 걸릴 수 있어요.` : ''}
      </p>
      {error && (
        <p className={styles.error} role="alert">
          {error} 규칙 기반 초안은 그대로 만들 수 있어요.
        </p>
      )}
    </section>
  );
}
