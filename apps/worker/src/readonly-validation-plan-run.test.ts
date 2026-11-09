import { afterEach, expect, it, vi } from 'vitest';

const originalArgv = process.argv;
const originalExitCode = process.exitCode;
afterEach(() => {
  process.argv = originalArgv;
  process.exitCode = originalExitCode;
});

async function run(args: string[]) {
  vi.resetModules();
  process.argv = [process.execPath, 'readonly-validation-plan-run.ts', ...args];
  process.exitCode = 0;
  const info = vi.spyOn(console, 'info').mockImplementation(() => {});
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  info.mockClear();
  error.mockClear();
  await import('./readonly-validation-plan-run.js');
  return {
    code: process.exitCode,
    output: info.mock.calls.map(([line]) => JSON.parse(line as string)),
    errors: error.mock.calls.map(([line]) => JSON.parse(line as string)),
  };
}

const regular = [
  '--kind=regular',
  '--start-at=2026-11-09T00:00:00Z',
  '--deadline=2026-11-09T01:11:00Z',
  '--interval-seconds=60',
  '--session-start=2026-11-09T00:00:00Z',
  '--session-end=2026-11-09T06:30:00Z',
];

it('소스 CLI의 무접속 미리보기와 정규장 계획을 자식 실행 없이 검사한다', async () => {
  expect(await run([])).toMatchObject({
    code: 0,
    errors: [],
    output: [{ state: 'preview', kinds: ['session', 'expiry', 'regular'], scheduled: false, executionEnabled: false }],
  });
  expect(await run(regular)).toMatchObject({
    code: 0,
    errors: [],
    output: [
      {
        kind: 'regular',
        state: 'prepared',
        samples: 60,
        regularOnly: true,
        observedTtlSeconds: null,
        boundaryAt: null,
      },
    ],
  });
  expect(
    await run(regular.map((arg) => (arg.startsWith('--deadline=') ? '--deadline=2026-11-09T06:30:00Z' : arg))),
  ).toMatchObject({ code: 2, errors: [], output: [{ state: 'blocked', blockers: ['OUTSIDE_REGULAR_SESSION'] }] });
});

it('계획 CLI는 실행/job id/다른 kind 세션 옵션과 중복·혼합·누락을 거부한다', async () => {
  for (const args of [
    ['--execute'],
    ['--kind=expiry', '--kind=session'],
    ...[
      '--job-id=kr-2026-11-09',
      '--ttl-seconds=120',
      '--boundary-at=2026-11-09T01:00:00Z',
      '--session-start=2026-11-09T00:00:00Z',
    ].map((option) => [...regular, option]),
    [...regular, '--session-end', '2026-11-09T06:30:00Z'],
    regular.filter((arg) => !arg.startsWith('--session-start=')),
    regular.filter((arg) => !arg.startsWith('--session-end=')),
    ['--session-start=2026-11-09T00:00:00Z'],
    ...['session', 'expiry'].flatMap((kind) =>
      ['--session-start=2026-11-09T00:00:00Z', '--session-end=2026-11-09T06:30:00Z'].map((option) => [
        `--kind=${kind}`,
        '--start-at=2026-11-04T20:55:00Z',
        '--deadline=2026-11-04T21:10:00Z',
        '--interval-seconds=30',
        kind === 'session' ? '--boundary-at=2026-11-04T21:00:00Z' : '--ttl-seconds=120',
        option,
      ]),
    ),
  ])
    expect(await run(args)).toMatchObject({
      code: 1,
      output: [],
      errors: [
        {
          code: 'READONLY_VALIDATION_PLAN_INVALID',
          executionEnabled: false,
        },
      ],
    });
});
