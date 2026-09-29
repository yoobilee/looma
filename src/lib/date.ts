// 날짜 계산과 한국어 표기. 외부 라이브러리 없이 Intl만 사용한다.

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export function startOfDay(date: Date): Date {
  const copy = new Date(date);
  copy.setHours(0, 0, 0, 0);
  return copy;
}

export function isSameDay(a: Date, b: Date): boolean {
  return startOfDay(a).getTime() === startOfDay(b).getTime();
}

export function isToday(iso: string | undefined, now = new Date()): boolean {
  return !!iso && isSameDay(new Date(iso), now);
}

/** 월요일 시작 기준으로 같은 주인지 확인한다. */
export function isThisWeek(iso: string | undefined, now = new Date()): boolean {
  if (!iso) return false;
  const start = startOfDay(now);
  const weekday = (start.getDay() + 6) % 7; // 월=0
  start.setDate(start.getDate() - weekday);
  const end = new Date(start.getTime() + 7 * DAY);
  const target = new Date(iso).getTime();
  return target >= start.getTime() && target < end.getTime();
}

export function dayKey(iso: string): string {
  const date = new Date(iso);
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

const timeFormatter = new Intl.DateTimeFormat('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false });
const monthDayFormatter = new Intl.DateTimeFormat('ko-KR', { month: 'long', day: 'numeric' });
const fullDateFormatter = new Intl.DateTimeFormat('ko-KR', { month: 'long', day: 'numeric', weekday: 'long' });

export function formatTime(iso: string): string {
  return timeFormatter.format(new Date(iso));
}

export function formatMonthDay(iso: string): string {
  return monthDayFormatter.format(new Date(iso));
}

export function formatFullDate(date: Date): string {
  return fullDateFormatter.format(date);
}

/** 09.29 형태 */
export function formatShortDate(iso: string): string {
  const date = new Date(iso);
  return `${String(date.getMonth() + 1).padStart(2, '0')}.${String(date.getDate()).padStart(2, '0')}`;
}

export function formatDateRange(start?: string, end?: string): string {
  if (!start && !end) return '기간 미정';
  if (start && end) return `${formatShortDate(start)}–${formatShortDate(end)}`;
  return start ? `${formatShortDate(start)}부터` : `${formatShortDate(end as string)}까지`;
}

/** 업무 기한 표기: 오늘 15:00, 내일, 10.01 */
export function formatDue(iso: string | undefined, now = new Date()): string {
  if (!iso) return '기한 없음';
  const date = new Date(iso);
  const diffDays = Math.round((startOfDay(date).getTime() - startOfDay(now).getTime()) / DAY);
  const hasTime = date.getHours() !== 0 || date.getMinutes() !== 0;
  if (diffDays === 0) return hasTime ? `오늘 ${formatTime(iso)}` : '오늘';
  if (diffDays === 1) return hasTime ? `내일 ${formatTime(iso)}` : '내일';
  if (diffDays === -1) return '어제';
  return formatShortDate(iso);
}

export function formatElapsed(fromIso: string, now = new Date()): string {
  const minutes = Math.max(0, Math.floor((now.getTime() - new Date(fromIso).getTime()) / MINUTE));
  if (minutes < 60) return `${minutes}분째`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours}시간 ${rest}분째` : `${hours}시간째`;
}

export function formatRemaining(toIso: string, now = new Date()): string {
  const minutes = Math.floor((new Date(toIso).getTime() - now.getTime()) / MINUTE);
  if (minutes <= 0) return '곧 비워져요';
  if (minutes < 60) return `${minutes}분 뒤 비워져요`;
  return `${Math.floor(minutes / 60)}시간 뒤 비워져요`;
}

export function greetingFor(date: Date): string {
  const hour = date.getHours();
  if (hour < 5) return '늦은 시간까지 수고 많아요.';
  if (hour < 12) return '좋은 아침이에요.';
  if (hour < 18) return '좋은 오후예요.';
  return '좋은 저녁이에요.';
}

export const durations = { MINUTE, HOUR, DAY };
