import { expect, it } from 'vitest';
import { parseReadonlySupervisor } from './readonly-supervisor-config.js';

const regular = [
  '--kind=regular',
  '--start-at=2026-11-09T00:00:00Z',
  '--deadline=2026-11-09T01:11:00Z',
  '--interval-seconds=60',
  '--session-start=2026-11-09T00:00:00Z',
  '--session-end=2026-11-09T06:30:00Z',
];

it('demo 정규장에도 기존 스키마의 시장·거래일 일치 job id가 필수다', () => {
  for (const id of ['kr-2026-11-09', 'kr-2026-11-09-retry-1', 'kr-2026-11-09-retry-99']) {
    expect(parseReadonlySupervisor([...regular, `--job-id=${id}`], {})).toMatchObject({
      execute: false,
      source: 'demo',
      instrument: { market: 'KR', symbol: '005930' },
      observationJobId: id,
      plan: { state: 'prepared', samples: 60, regularOnly: true },
    });
  }
  for (const args of [
    [],
    ['--job-id=us-2026-11-09'],
    ['--job-id=kr-2026-11-08'],
    ['--job-id=kr-2026-02-30'],
    ['--job-id=kr-2026-11-09-retry-0'],
    ['--job-id=kr-2026-11-09-retry-100'],
    ['--job-id=kr-2026-11-09', '--job-id', 'kr-2026-11-09'],
  ])
    expect(() => parseReadonlySupervisor([...regular, ...args], {})).toThrow();
});

it('미국 job 날짜는 UTC가 아닌 시장 거래일에 맞춘다', () => {
  const args = regular.map((arg) =>
    arg.startsWith('--session-start=') ? '--session-start=2026-11-08T23:00:00Z' : arg,
  );
  expect(
    parseReadonlySupervisor([...args, '--source=market', '--symbol=US:AAPL', '--job-id=us-2026-11-08'], {}),
  ).toMatchObject({ observationJobId: 'us-2026-11-08', instrument: { market: 'US', symbol: 'AAPL' } });
  expect(() =>
    parseReadonlySupervisor([...args, '--source=market', '--symbol=US:AAPL', '--job-id=us-2026-11-09'], {}),
  ).toThrow();
});

it('다른 kind와 미리보기에서 정규장 전용 옵션을 거부하고 기존 return 필드를 보존한다', () => {
  const inputs = [
    [],
    [
      '--kind=session',
      '--start-at=2026-11-04T20:55:00Z',
      '--boundary-at=2026-11-04T21:00:00Z',
      '--deadline=2026-11-04T21:10:00Z',
      '--interval-seconds=30',
    ],
    [
      '--kind=expiry',
      '--start-at=2026-11-04T21:15:00Z',
      '--ttl-seconds=120',
      '--deadline=2026-11-04T22:00:00Z',
      '--interval-seconds=30',
    ],
  ];
  for (const args of inputs) {
    expect(Object.keys(parseReadonlySupervisor(args, {}))).toEqual([
      'execute',
      'fingerprint',
      'source',
      'instrument',
      'plan',
      'expectedPlanHash',
      'expectedBuildHash',
    ]);
    for (const option of [
      '--job-id=kr-2026-11-09',
      '--session-start=2026-11-09T00:00:00Z',
      '--session-end=2026-11-09T06:30:00Z',
    ]) {
      expect(() => parseReadonlySupervisor([...args, option], {})).toThrow();
    }
  }
});

it('정규장 TTL/경계·세션 누락·중복 옵션을 거부한다', () => {
  const args = [...regular, '--job-id=kr-2026-11-09'];
  for (const option of [
    '--ttl-seconds=120',
    '--boundary-at=2026-11-09T01:00:00Z',
    '--session-start=2026-11-09T00:00:00Z',
    '--session-end=2026-11-09T06:30:00Z',
  ]) {
    expect(() => parseReadonlySupervisor([...args, option], {})).toThrow();
  }
  for (const key of ['--session-start=', '--session-end=']) {
    expect(() =>
      parseReadonlySupervisor(
        args.filter((arg) => !arg.startsWith(key)),
        {},
      ),
    ).toThrow();
  }
});
