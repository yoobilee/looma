import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useRepositoryData } from '@/hooks/useRepositoryData';
import { PageHeader } from '@/components/layout/PageHeader';
import { SectionHeader } from '@/components/ui/SectionHeader';
import { LoadingState, StateMessage } from '@/components/ui/StateMessage';
import { TermDetail } from './TermDetail';
import { TermCreateDialog } from './TermCreateDialog';
import styles from './KnowledgePage.module.css';

/** 업무 용어와 참고 지식. AI 초안은 사용자가 검토한 뒤에만 반영된다. */
export function KnowledgePage() {
  const { termId } = useParams();
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const data = useRepositoryData(async (repos) => ({ terms: await repos.knowledge.list(), projects: await repos.projects.list() }), []);

  const terms = [...(data.data?.terms ?? [])].sort((a, b) => a.term.localeCompare(b.term, 'ko'));
  const filtered = terms.filter((term) => !query.trim() || `${term.term} ${term.explanation} ${term.tags.join(' ')}`.toLowerCase().includes(query.trim().toLowerCase()));
  const selected = terms.find((term) => term.id === termId) ?? filtered[0];

  return (
    <>
      <PageHeader eyebrow="업무 지식" title="용어집" searchPlaceholder="용어, 설명, 프로젝트 검색" />

      {data.status === 'loading' && <LoadingState />}
      {data.status === 'error' && <StateMessage tone="error" title="업무 지식을 불러오지 못했어요." />}

      {data.status === 'success' && (
        <div className={styles.layout}>
          <nav className={styles.list} aria-labelledby="term-list-title">
            <SectionHeader id="term-list-title" title="용어" meta={`${terms.length}개`} />
            <label className={styles.filter}>
              <span className="visually-hidden">용어 걸러 보기</span>
              <input type="search" placeholder="용어 걸러 보기" value={query} onChange={(event) => setQuery(event.target.value)} />
            </label>
            <ul>
              {filtered.map((term) => (
                <li key={term.id}>
                  <Link
                    to={`/knowledge/${term.id}`}
                    className={`${styles.term} ${term.id === selected?.id ? styles.termActive : ''}`}
                    aria-current={term.id === selected?.id ? 'page' : undefined}
                  >
                    {term.term}
                  </Link>
                </li>
              ))}
            </ul>
            {filtered.length === 0 && <p className={styles.empty}>“{query}”에 맞는 용어가 없어요.</p>}

            <button type="button" className={styles.newTerm} onClick={() => setCreateOpen(true)}>
              <strong>새 용어 추가</strong>
              <span>용어만 입력하고 설명·업무 의미·예시는 필요한 만큼 채워요.</span>
            </button>
          </nav>

          <div className={styles.detail}>
            {selected ? (
              <TermDetail key={selected.id} term={selected} projects={data.data.projects} />
            ) : (
              <StateMessage title="아직 정리한 용어가 없어요." description="고객사 고유 용어, 프로젝트 약어를 모아두면 온보딩과 TC 작성에 도움이 돼요." />
            )}
          </div>
        </div>
      )}

      <TermCreateDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={(id) => {
          setCreateOpen(false);
          navigate(`/knowledge/${id}`);
        }}
        projects={data.data?.projects ?? []}
      />
    </>
  );
}
