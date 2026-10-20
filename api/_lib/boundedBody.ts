/**
 * 본문을 바이트 한도까지만 읽어 문자열로 돌려준다. 한도를 넘으면 읽기를 멈추고(스트림을 취소하고) undefined를 돌려준다.
 * 길이를 선언한 헤더(content-length)가 이미 한도를 넘으면 읽지 않는다. 선언이 없거나 거짓이어도 실제로 읽은 바이트로 센다.
 */
export async function readBoundedText(body: ReadableStream<Uint8Array> | null, declaredLength: string | null, maxBytes: number): Promise<string | undefined> {
  const declared = Number(declaredLength);
  if (declaredLength !== null && Number.isFinite(declared) && declared > maxBytes) {
    await body?.cancel().catch(() => undefined);
    return undefined;
  }
  if (!body) return '';
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return undefined;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}
