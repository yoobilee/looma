import { useCallback, useEffect, useRef, useState } from 'react';
import { repositories, type Repositories } from '@/data';

export type DataState<T> =
  | { status: 'loading'; data?: T; error?: undefined }
  | { status: 'success'; data: T; error?: undefined }
  | { status: 'error'; data?: T; error: Error };

/**
 * repository 호출 결과를 상태로 제공한다.
 * - deps가 바뀌면 다시 불러온다. (값 비교를 위해 JSON 직렬화 키를 사용)
 * - 저장소 데이터가 바뀌면 자동으로 다시 불러온다.
 * - 늦게 도착한 이전 요청 결과는 버린다.
 */
export function useRepositoryData<T>(
  loader: (repos: Repositories) => Promise<T>,
  deps: readonly unknown[],
): DataState<T> & { reload: () => void } {
  const [state, setState] = useState<DataState<T>>({ status: 'loading' });
  const [version, setVersion] = useState(0);
  const loaderRef = useRef(loader);
  const depsKey = JSON.stringify(deps);

  useEffect(() => {
    loaderRef.current = loader;
  });

  useEffect(() => {
    let cancelled = false;
    loaderRef
      .current(repositories)
      .then((data) => {
        if (!cancelled) setState({ status: 'success', data });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setState((previous) => ({
          status: 'error',
          data: previous.data,
          error: error instanceof Error ? error : new Error('데이터를 불러오지 못했어요.'),
        }));
      });
    return () => {
      cancelled = true;
    };
  }, [depsKey, version]);

  useEffect(() => repositories.subscribe(() => setVersion((current) => current + 1)), []);

  const reload = useCallback(() => setVersion((current) => current + 1), []);

  return { ...state, reload };
}
