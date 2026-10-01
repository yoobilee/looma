/** 다른 Looma 탭에 저장 사실을 알리는 메시지. 데이터 내용은 보내지 않는다. */
export interface StateUpdatedMessage {
  type: 'state-updated';
  revision: number;
  savedAt: string;
}

export interface StateChannel {
  post(message: StateUpdatedMessage): void;
  subscribe(listener: (message: StateUpdatedMessage) => void): () => void;
}

const CHANNEL_NAME = 'looma-state';

const isStateUpdated = (value: unknown): value is StateUpdatedMessage =>
  typeof value === 'object' &&
  value !== null &&
  (value as StateUpdatedMessage).type === 'state-updated' &&
  Number.isInteger((value as StateUpdatedMessage).revision);

/**
 * 브라우저 BroadcastChannel로 다른 탭에 알린다. 지원하지 않는 브라우저에서는 아무것도 하지 않는다.
 * 알림은 빠른 안내일 뿐이고, 덮어쓰기를 막는 최종 장치는 저장소의 revision 확인이다.
 */
export function createBroadcastStateChannel(): StateChannel {
  if (typeof BroadcastChannel === 'undefined') return { post: () => undefined, subscribe: () => () => undefined };
  const channel = new BroadcastChannel(CHANNEL_NAME);
  return {
    post(message) {
      try {
        channel.postMessage(message);
      } catch {
        // 알림이 실패해도 저장은 이미 끝났다. 다른 탭은 다음 저장 시 revision 확인으로 충돌을 안다.
      }
    },
    subscribe(listener) {
      const handle = (event: MessageEvent) => {
        if (isStateUpdated(event.data)) listener(event.data);
      };
      channel.addEventListener('message', handle);
      return () => channel.removeEventListener('message', handle);
    },
  };
}

/** 같은 프로세스 안의 여러 저장소 인스턴스를 잇는 채널. 여러 탭을 흉내 내는 테스트에서 쓴다. */
export function createMemoryChannelHub() {
  const listeners = new Set<(message: StateUpdatedMessage) => void>();
  return {
    connect(): StateChannel {
      const own = new Set<(message: StateUpdatedMessage) => void>();
      return {
        // BroadcastChannel처럼 보낸 쪽 자신에게는 전달하지 않는다.
        post: (message) => listeners.forEach((listener) => !own.has(listener) && listener(message)),
        subscribe(listener) {
          listeners.add(listener);
          own.add(listener);
          return () => {
            listeners.delete(listener);
            own.delete(listener);
          };
        },
      };
    },
  };
}
