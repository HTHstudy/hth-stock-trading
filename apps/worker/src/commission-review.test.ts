import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';
import { contentHash } from '@hth/database';
import { commissionEvidenceSchema, reviewCommissionAssumptions } from './commission-review.js';

const now = '2026-11-05T15:01:00.000Z';
const assumption = { id: 'sample', market: 'KR', buyFeeBps: '1.5', sellFeeBps: '30' };
function evidence() {
  return commissionEvidenceSchema.parse({
    formatVersion: 'commission-evidence-v1',
    source: 'toss-readonly',
    observedAt: now,
    executionEnabled: false,
    rates: [{ market: 'KR', rate: '0.00015', startsOn: '2026-01-01', endsOn: '2026-12-31', periodBoundsKnown: true }],
  });
}
it('소수 비율을 bps로 정확히 바꾸되 실제 비용/과거 기간 검증으로 승격하지 않는다', () => {
  const report = reviewCommissionAssumptions(evidence(), [assumption], now);
  expect(report.rows[0]).toMatchObject({
    status: 'available',
    observedCommissionBps: '1.5',
    buyMatchesObservedRate: true,
    sellMatchesObservedRate: false,
  });
  expect(report).toMatchObject({
    dateKst: '2026-11-06',
    historicalFeesVerified: false,
    sideSpecificFeesVerified: false,
    taxesVerified: false,
    roundingRulesVerified: false,
    priceTickVerified: false,
    slippageVerified: false,
    assumptionsApplied: false,
    executionEnabled: false,
    canResume: false,
  });
  const zero = evidence();
  zero.rates[0]!.rate = '0';
  expect(reviewCommissionAssumptions(zero, [{ ...assumption, buyFeeBps: '0' }], now).rows[0]).toMatchObject({
    status: 'available',
    observedCommissionBps: '0',
    buyMatchesObservedRate: true,
  });
});
it('국내/해외 모두 KST 날짜와 시작/종료일의 포함 경계를 사용한다', () => {
  const input = evidence();
  input.rates[0]!.market = 'US';
  input.rates[0]!.startsOn = '2026-11-06';
  input.rates[0]!.endsOn = '2026-11-06';
  expect(reviewCommissionAssumptions(input, [{ ...assumption, market: 'US' }], now).rows[0]!.status).toBe('available');
  const earlier = '2026-11-05T14:59:00.000Z';
  input.observedAt = earlier;
  expect(reviewCommissionAssumptions(input, [{ ...assumption, market: 'US' }], earlier).rows[0]!.status).toBe(
    'not-effective',
  );
});
it('미래/만료된 증거를 현재 요율 비교에 사용하지 않는다', () => {
  const at = (offset: number) => new Date(Date.parse(now) + offset).toISOString();
  expect(reviewCommissionAssumptions(evidence(), [assumption], at(300000)).evidenceFresh).toBe(true);
  for (const time of [at(300001), at(-1)])
    expect(reviewCommissionAssumptions(evidence(), [assumption], time).rows[0]).toMatchObject({
      status: 'stale',
      observedCommissionBps: null,
      buyMatchesObservedRate: null,
      sellMatchesObservedRate: null,
    });
});
it('중복·겹침·기간 미상 행이 있으면 임의의 첫 요율을 고르지 않는다', () => {
  const input = evidence();
  input.rates.push({ ...input.rates[0]! });
  expect(reviewCommissionAssumptions(input, [assumption], now).rows[0]!.status).toBe('ambiguous');
  input.rates[1]!.periodBoundsKnown = false;
  expect(reviewCommissionAssumptions(input, [assumption], now).rows[0]!.status).toBe('ambiguous');
  input.rates.splice(0, 1);
  expect(reviewCommissionAssumptions(input, [assumption], now).rows[0]).toMatchObject({
    status: 'period-unknown',
    observedCommissionBps: null,
  });
});
it('행 없음/기간 밖/명시적 무기한과 누락 기간을 구분한다', () => {
  const input = evidence();
  expect(reviewCommissionAssumptions(input, [{ ...assumption, market: 'US' }], now).rows[0]!.status).toBe('missing');
  input.rates[0]!.endsOn = '2026-11-05';
  expect(reviewCommissionAssumptions(input, [assumption], now).rows[0]).toMatchObject({
    status: 'not-effective',
    observedCommissionBps: null,
  });
  input.rates[0]!.startsOn = null;
  input.rates[0]!.endsOn = null;
  expect(reviewCommissionAssumptions(input, [assumption], now).rows[0]!.status).toBe('available');
  input.rates[0]!.periodBoundsKnown = false;
  expect(reviewCommissionAssumptions(input, [assumption], now).rows[0]!.status).toBe('period-unknown');
});
it('잘못된 요율·날짜·중복 ID·원본 계좌 필드를 거부한다', () => {
  for (const rate of ['-0.1', '1', 'NaN', '1e-3']) {
    const input = evidence();
    input.rates[0]!.rate = rate;
    expect(() => reviewCommissionAssumptions(input, [assumption], now)).toThrow();
  }
  const reversed = evidence();
  reversed.rates[0]!.startsOn = '2027-01-01';
  expect(() => reviewCommissionAssumptions(reversed, [assumption], now)).toThrow();
  expect(() => reviewCommissionAssumptions(evidence(), [assumption, assumption], now)).toThrow();
  expect(() => reviewCommissionAssumptions({ ...evidence(), accountId: 'private' }, [assumption], now)).toThrow();
});
it('오프라인 CLI는 키/DB 없이 검토하고 기존 출력과 입력을 보존한다', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'hth-commission-review-'));
  const command = resolve('apps/worker/dist/commission-review-run.js');
  const execute = promisify(execFile);
  const options = { cwd: folder, env: { TRADING_MODE: 'paper' }, timeout: 10000 };
  try {
    expect(JSON.parse((await execute(process.execPath, [command], options)).stdout).state).toBe('preview');
    await writeFile(join(folder, 'input.json'), JSON.stringify(evidence()));
    await writeFile(join(folder, 'assumptions.json'), JSON.stringify([assumption]));
    const args = [
      command,
      '--input=input.json',
      '--assumptions=assumptions.json',
      '--output=report.json',
      `--reviewed-at=${now}`,
    ];
    expect(JSON.parse((await execute(process.execPath, args, options)).stdout)).toMatchObject({
      state: 'reviewed',
      rows: 1,
      executionEnabled: false,
    });
    const bytes = await readFile(join(folder, 'report.json'), 'utf8');
    const artifact = JSON.parse(bytes);
    expect(artifact.hash).toBe(contentHash(artifact.report));
    expect(bytes).not.toContain('accountId');
    await expect(execute(process.execPath, args, options)).rejects.toMatchObject({
      stderr: expect.stringContaining('COMMISSION_REVIEW_NOT_COMPLETED'),
    });
    expect(await readFile(join(folder, 'report.json'), 'utf8')).toBe(bytes);
    for (const invalid of [['--execute'], ['--input=input.json', '--input=input.json'], ['--output=report.json']])
      await expect(execute(process.execPath, [command, ...invalid], options)).rejects.toThrow();
    await expect(execute(process.execPath, [command], { ...options, env: { TRADING_MODE: 'live' } })).rejects.toThrow();
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}, 30000);
