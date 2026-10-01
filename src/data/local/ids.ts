/**
 * 엔티티 ID. 여러 탭이 같은 저장소에 동시에 쓰므로 탭마다 따로 세는 카운터나 시각으로는 유일성을 보장할 수 없다.
 * 브라우저 암호학적 난수(crypto.randomUUID, 없으면 crypto.getRandomValues)만 쓰고, 약한 난수로 몰래 대신하지 않는다.
 * 정렬은 createdAt 등 별도 필드가 맡으므로 ID에는 시각 의미가 없다.
 */
export function createRandomId(prefix: string, cryptoApi: Partial<Pick<Crypto, 'getRandomValues' | 'randomUUID'>> | undefined = globalThis.crypto): string {
  if (typeof cryptoApi?.randomUUID === 'function') return `${prefix}-${cryptoApi.randomUUID()}`;
  if (typeof cryptoApi?.getRandomValues === 'function') return `${prefix}-${uuidFromRandomBytes(cryptoApi.getRandomValues(new Uint8Array(16)))}`;
  throw new Error('안전한 난수 생성기를 사용할 수 없어 ID를 만들지 못했어요.');
}

/** 16바이트 난수를 RFC 4122 버전 4 UUID 문자열로 바꾼다. */
export function uuidFromRandomBytes(bytes: Uint8Array): string {
  if (bytes.length !== 16) throw new Error('UUID에는 16바이트가 필요해요.');
  const copy = Uint8Array.from(bytes);
  copy[6] = (copy[6] & 0x0f) | 0x40;
  copy[8] = (copy[8] & 0x3f) | 0x80;
  const hex = [...copy].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
