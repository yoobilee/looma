import { Link } from 'react-router-dom';
import { useAppCommands } from '@/app/commandsContext';
import { SectionHeader } from '@/components/ui/SectionHeader';
import styles from './QuickStart.module.css';

export function QuickStart() {
  const { openTaskCreate, openScratchDrawer } = useAppCommands();

  return (
    <section aria-labelledby="quick-start-title" className={styles.section}>
      <SectionHeader id="quick-start-title" title="빠른 시작" meta="자주 쓰는 작업" />
      <div className={styles.grid}>
        <button type="button" className={styles.action} onClick={() => openTaskCreate()}>
          <strong>업무 추가</strong>
          <span>할 일을 바로 등록</span>
        </button>
        <button type="button" className={styles.action} onClick={openScratchDrawer}>
          <strong>메모 작성</strong>
          <span>짧게 기록 남기기</span>
        </button>
        <Link to="/scratch" className={styles.action}>
          <strong>자료 고정</strong>
          <span>임시 자료를 보관</span>
        </Link>
        <Link to="/records" className={styles.action}>
          <strong>하루 정리</strong>
          <span>오늘 기록 묶기</span>
        </Link>
      </div>
    </section>
  );
}
