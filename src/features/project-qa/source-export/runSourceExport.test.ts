import { afterEach, describe, expect, it, vi } from 'vitest';
import { downloadFile, OBJECT_URL_REVOKE_DELAY_MS } from '@/lib/downloadFile';
import { runSourceExport } from './runSourceExport';

const okOutcome = { ok: true as const, fileName: '고객사_TC_Looma.xlsx', bytes: new Uint8Array([1, 2, 3]), changedCells: ['D4'], notices: ['신규 TC 1건'] };

describe('내보내기 버튼 실행', () => {
  it('성공하면 내려받고 반영 셀 수를 알려 준다', async () => {
    const download = vi.fn();
    const state = await runSourceExport(async () => okOutcome, download);
    expect(download).toHaveBeenCalledWith(okOutcome.bytes, '고객사_TC_Looma.xlsx');
    expect(state).toEqual({ status: 'done', message: '고객사_TC_Looma.xlsx · 셀 1개에 현재 값을 반영했어요.', notices: ['신규 TC 1건'] });
  });

  it('검증 실패면 내려받지 않고 이유를 돌려준다', async () => {
    const download = vi.fn();
    expect(await runSourceExport(async () => ({ ok: false, problems: ['수식 셀'] }), download)).toEqual({ status: 'failed', problems: ['수식 셀'] });
    expect(download).not.toHaveBeenCalled();
  });

  it('내보내기나 다운로드가 던져도 실패 상태로 돌아온다(내보내는 중에 멈추지 않는다)', async () => {
    const exportFailed = await runSourceExport(() => Promise.reject(new Error('boom')), vi.fn());
    expect(exportFailed.status).toBe('failed');
    const downloadFailed = await runSourceExport(async () => okOutcome, () => {
      throw new Error('blocked');
    });
    expect(downloadFailed).toEqual({ status: 'failed', problems: [expect.stringContaining('파일을 내려받지 못했어요')] });
  });
});

describe('downloadFile', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function fakeDocument(click: () => void) {
    const link = { href: '', download: '', rel: '', style: { display: '' }, click, remove: vi.fn() };
    vi.stubGlobal('document', { createElement: () => link, body: { append: vi.fn() } });
    return link;
  }

  it('클릭이 실패하면 object URL을 바로 해제하고 오류를 그대로 던진다', () => {
    const create = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:test');
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    const link = fakeDocument(() => {
      throw new Error('click blocked');
    });
    expect(() => downloadFile(new Uint8Array([1]), 'a.xlsx', 'application/x')).toThrow('click blocked');
    expect(create).toHaveBeenCalledTimes(1);
    expect(revoke).toHaveBeenCalledWith('blob:test');
    expect(link.remove).toHaveBeenCalled();
  });

  it('성공하면 다운로드가 시작될 시간을 두고 해제한다', () => {
    vi.useFakeTimers();
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:ok');
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    const link = fakeDocument(vi.fn());
    downloadFile(new Uint8Array([1]), '고객사_TC_Looma.xlsx', 'application/x');
    expect(link).toMatchObject({ href: 'blob:ok', download: '고객사_TC_Looma.xlsx' });
    expect(revoke).not.toHaveBeenCalled();
    vi.advanceTimersByTime(OBJECT_URL_REVOKE_DELAY_MS);
    expect(revoke).toHaveBeenCalledWith('blob:ok');
  });
});
