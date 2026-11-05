import { afterEach, expect, it, vi } from 'vitest';
import { BACKTESTS_API } from '../index.js';

const left = 'a'.repeat(64);
const right = 'b'.repeat(64);
function fixture() {
  return {
    formatVersion: 'backtest-cost-pair-v1',
    leftReportHash: left,
    rightReportHash: right,
    currency: 'KRW',
    status: 'incomparable',
    reason: 'COSTS_NOT_ORDERED',
    comparison: null,
    executionEnabled: false,
    canResume: false,
  };
}
afterEach(() => vi.unstubAllGlobals());

it('검증한 hash query와 취소 signal을 전송하고 DTO를 검증한다', async () => {
  const controller = new AbortController();
  const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(fixture())));
  vi.stubGlobal('fetch', fetch);
  expect(await BACKTESTS_API.compare(left, right, controller.signal)).toEqual(fixture());
  const [url, init] = fetch.mock.calls[0]!;
  expect(url).toBe(`/api/v1/backtest-comparison?left=${left}&right=${right}`);
  expect(init).toMatchObject({ cache: 'no-store', credentials: 'same-origin' });
  controller.abort();
  expect(init.signal.aborted).toBe(true);
});

it('잘못된 hash는 요청하지 않는다', async () => {
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  await expect(BACKTESTS_API.compare('../bad', right)).rejects.toThrow();
  expect(fetch).not.toHaveBeenCalled();
});

it.each([
  { ...fixture(), rightReportHash: 'c'.repeat(64) },
  { ...fixture(), reason: 'UNKNOWN' },
  { ...fixture(), executionEnabled: true },
  { ...fixture(), canResume: true },
  { ...fixture(), privateData: 'not allowed' },
])('불일치·알 수 없는 DTO를 거부한다', async (data) => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(data))));
  await expect(BACKTESTS_API.compare(left, right)).rejects.toThrow();
});

it('HTTP 오류를 빈 비교 성공으로 바꾸지 않는다', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 503 })));
  await expect(BACKTESTS_API.compare(left, right)).rejects.toThrow('REPORTS_UNAVAILABLE');
});
