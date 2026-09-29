import { useState } from 'react';
import { Link } from 'react-router-dom';
import { repositories } from '@/data';
import type { KnowledgeTerm, Project } from '@/domain/types';
import { Button } from '@/components/ui/Button';
import { TextAreaField } from '@/components/ui/Field';
import { Tag } from '@/components/ui/Tag';
import styles from './TermDetail.module.css';

interface TermDetailProps {
  term: KnowledgeTerm;
  projects: Project[];
}

export function TermDetail({ term, projects }: TermDetailProps) {
  const [editing, setEditing] = useState(false);
  const [explanation, setExplanation] = useState(term.explanation);
  const [workMeaning, setWorkMeaning] = useState(term.workMeaning ?? '');
  const [userNote, setUserNote] = useState(term.userNote ?? '');
  const relatedProjects = projects.filter((project) => term.relatedProjectIds.includes(project.id));

  const save = async () => {
    await repositories.knowledge.update(term.id, {
      explanation: explanation.trim(),
      workMeaning: workMeaning.trim() || undefined,
      userNote: userNote.trim() || undefined,
    });
    setEditing(false);
  };

  const applyDraft = async () => {
    if (!term.aiDraft) return;
    await repositories.knowledge.update(term.id, { explanation: term.aiDraft.explanation, aiDraftUsed: true });
    setExplanation(term.aiDraft.explanation);
  };

  return (
    <article className={styles.detail} aria-labelledby="term-title">
      <header className={styles.header}>
        <h2 id="term-title" className={styles.title}>
          {term.term}
        </h2>
        {editing ? (
          <div className={styles.headerActions}>
            <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
              취소
            </Button>
            <Button size="sm" variant="primary" onClick={() => void save()} disabled={!explanation.trim()}>
              저장
            </Button>
          </div>
        ) : (
          <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>
            편집
          </Button>
        )}
      </header>

      {editing ? (
        <div className={styles.form}>
          <TextAreaField label="쉬운 설명" value={explanation} onChange={(event) => setExplanation(event.target.value)} />
          <TextAreaField label="업무에서의 의미" value={workMeaning} onChange={(event) => setWorkMeaning(event.target.value)} />
          <TextAreaField label="메모" value={userNote} onChange={(event) => setUserNote(event.target.value)} />
        </div>
      ) : (
        <>
          <p className={styles.lead}>{term.explanation || '아직 설명이 없어요. 편집을 눌러 채워주세요.'}</p>
          {term.aiDraftUsed && <Tag tone="outline">AI 초안을 검토해 반영함</Tag>}

          {term.workMeaning && (
            <section className={styles.block}>
              <h3>업무에서의 의미</h3>
              <p>{term.workMeaning}</p>
            </section>
          )}

          {term.examples.length > 0 && (
            <section className={styles.block}>
              <h3>예시</h3>
              <ul className={styles.examples}>
                {term.examples.map((example) => (
                  <li key={example}>{example}</li>
                ))}
              </ul>
            </section>
          )}

          {relatedProjects.length > 0 && (
            <section className={styles.block}>
              <h3>관련 프로젝트</h3>
              <div className={styles.chips}>
                {relatedProjects.map((project) => (
                  <Link key={project.id} to={`/projects/${project.id}`} className={styles.chip}>
                    {project.name}
                  </Link>
                ))}
              </div>
            </section>
          )}

          {term.relatedTerms.length > 0 && (
            <section className={styles.block}>
              <h3>관련 용어</h3>
              <p className={styles.muted}>{term.relatedTerms.join(' · ')}</p>
            </section>
          )}
        </>
      )}

      {term.aiDraft && !editing && (
        <section className={styles.ai} aria-labelledby="ai-draft-title">
          <div className={styles.aiHeader}>
            <h3 id="ai-draft-title">AI 도움</h3>
            <Tag tone="outline">초안 · 검토 전</Tag>
          </div>
          <p className={styles.aiLabel}>설명 초안</p>
          <p className={styles.aiText}>{term.aiDraft.explanation}</p>
          <p className={styles.aiLabel}>비슷한 용어</p>
          <p className={styles.aiText}>{term.aiDraft.relatedKeywords.join(' · ')}</p>
          <p className={styles.aiCaution}>고객사 고유 용어는 AI가 확정할 수 없어요. 실제 사용 맥락과 비교한 뒤 반영하세요.</p>
          <Button variant="primary" size="sm" onClick={() => void applyDraft()} disabled={term.explanation === term.aiDraft.explanation}>
            {term.explanation === term.aiDraft.explanation ? '반영됨' : '설명에 반영'}
          </Button>
        </section>
      )}

      {!editing && term.userNote && (
        <section className={styles.block}>
          <h3>메모</h3>
          <p>{term.userNote}</p>
        </section>
      )}

      {term.tags.length > 0 && (
        <section className={styles.block}>
          <h3>태그</h3>
          <div className={styles.chips}>
            {term.tags.map((tag) => (
              <span key={tag} className={styles.chip}>
                {tag}
              </span>
            ))}
          </div>
        </section>
      )}
    </article>
  );
}
