import { useEffect, useState } from 'react';

/** 경과 시간·남은 시간 표시용 현재 시각. 기본 1분마다 갱신한다. */
export function useNow(intervalMs = 60_000): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return now;
}
