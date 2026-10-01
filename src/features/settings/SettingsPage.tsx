import { useState } from 'react';
import { useTheme } from '@/app/themeContext';
import { usePersistenceStatus } from '@/app/usePersistenceStatus';
import { Button } from '@/components/ui/Button';
import type { ThemePreference } from '@/domain/types';
import { PageHeader } from '@/components/layout/PageHeader';
import { SectionHeader } from '@/components/ui/SectionHeader';
import { LocalDataResetDialog } from './LocalDataResetDialog';
import styles from './SettingsPage.module.css';

const themeOptions: { value: ThemePreference; label: string; description: string }[] = [
  { value: 'light', label: '라이트', description: '기본 테마' },
  { value: 'dark', label: '다크', description: '같은 구조, 어두운 표면' },
];

const integrations = [
  { name: 'Google Calendar', detail: '오늘·다음 일정 읽기 전용 표시. 지금은 예시 일정이 보여요.' },
  { name: 'Figma', detail: 'Page/Frame 단위 산출물 연결. 지금은 링크만 저장해요.' },
  { name: 'AI 분석', detail: '요구사항 분석, TC 초안, 용어 설명 초안. 결과는 항상 사람이 검토해요.' },
  { name: '파일 파싱', detail: 'PDF · DOCX · XLSX · CSV 내용 읽기와 TC XLSX 내보내기.' },
];

export function SettingsPage() {
  const { theme, setTheme } = useTheme();
  const persistence = usePersistenceStatus();
  const [resetOpen, setResetOpen] = useState(false);
  const [resetDone, setResetDone] = useState(false);
  const savedLocally = persistence.state === 'ready' && persistence.mode === 'local';

  return (
    <>
      <PageHeader eyebrow="설정" title="테마 · 연결 · 데이터" />

      <div className={styles.layout}>
        <section aria-labelledby="theme-title">
          <SectionHeader id="theme-title" title="테마" />
          <fieldset className={styles.themes}>
            <legend className="visually-hidden">테마 선택</legend>
            {themeOptions.map((option) => (
              <label key={option.value} className={`${styles.theme} ${styles[option.value]} ${theme === option.value ? styles.selected : ''}`}>
                <input type="radio" name="theme" value={option.value} checked={theme === option.value} onChange={() => setTheme(option.value)} />
                <span className={styles.preview} aria-hidden />
                <strong>{option.label}</strong>
                <small>{option.description}</small>
              </label>
            ))}
          </fieldset>
          <p className={styles.note}>배경의 느린 움직임은 기기의 &lsquo;동작 줄이기&rsquo; 설정을 켜면 자동으로 멈춰요.</p>
        </section>

        <section aria-labelledby="integration-title">
          <SectionHeader id="integration-title" title="연결" meta="모두 연결 전" />
          <ul className={styles.integrations}>
            {integrations.map((item) => (
              <li key={item.name}>
                <div>
                  <strong>{item.name}</strong>
                  <p>{item.detail}</p>
                </div>
                <span className={styles.badge}>연결 전</span>
              </li>
            ))}
          </ul>
        </section>

        <section aria-labelledby="local-data-title">
          <SectionHeader id="local-data-title" title="로컬 데이터" meta={savedLocally ? '이 브라우저에 저장 중' : '저장하지 않는 모드'} />
          <div className={styles.localData}>
            <p>
              업무 · 프로젝트 · TC · 수행 결과와 가져온 원본 파일은 이 브라우저에만 저장돼요. 서버로 보내지 않아요. 다른 브라우저나 기기와는 공유되지 않아요.
            </p>
            <p className={styles.note}>초기화하면 저장된 작업 데이터와 가져온 원본 파일을 모두 삭제하고 예시 데이터로 다시 시작해요.</p>
            <div>
              <Button variant="secondary" onClick={() => setResetOpen(true)}>
                로컬 데이터 초기화
              </Button>
            </div>
            {resetDone && (
              <p className={styles.note} role="status">
                예시 데이터로 초기화했어요.
              </p>
            )}
          </div>
          <LocalDataResetDialog open={resetOpen} onClose={() => setResetOpen(false)} onDone={() => setResetDone(true)} />
        </section>
      </div>
    </>
  );
}
