import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { parseWorkerServiceConfig, workerCommand } from './worker-service-config.js';
it('키나 계좌가 있어도 기본 대기이며 resume 환경변수는 실행 권한이 아니다', () => {
  const config = parseWorkerServiceConfig({
    TOSS_CLIENT_ID: 'fixture',
    TOSS_CLIENT_SECRET: 'fixture',
    LOCAL_PAPER_ACCOUNT_ID: 'paper-demo-existing',
  });
  expect(config.mode).toBe('idle');
  expect(workerCommand(config)).toBeNull();
  for (const env of [
    { TRADING_MODE: 'live' },
    { WORKER_RESUME: 'true' },
    { WORKER_MODE: 'trade' },
    { WORKER_SOURCE: 'unknown' },
    { LOCAL_CONTAINER_MODE: 'true', NODE_ENV: 'test' },
  ])
    expect(() => parseWorkerServiceConfig(env)).toThrow('WORKER_SERVICE_CONFIGURATION_INVALID');
});
it('관측은 유한 샘플·새 UUID를 요구하고 명령에 사용자 문자열을 쉘로 전달하지 않는다', () => {
  const config = parseWorkerServiceConfig({
    WORKER_MODE: 'observe',
    WORKER_REQUEST_ID: randomUUID(),
    WORKER_SAMPLES: '2',
    WORKER_INTERVAL_SECONDS: '10',
  });
  expect(workerCommand(config)).toContain('--demo');
  expect(workerCommand(config)).toContain('--samples=2');
  for (const patch of [
    { WORKER_REQUEST_ID: 'existing' },
    { WORKER_SAMPLES: '0' },
    { WORKER_INTERVAL_SECONDS: '0' },
    { WORKER_SYMBOLS: 'KR:005930;whoami' },
    { WORKER_SYMBOLS: 'US:AAPL' },
  ])
    expect(() =>
      parseWorkerServiceConfig({ WORKER_MODE: 'observe', WORKER_REQUEST_ID: randomUUID(), ...patch }),
    ).toThrow();
});
it('Paper 서비스 명령에는 초기화·마이그레이션·재개가 없고 출처별 계좌를 분리한다', () => {
  const env = {
    WORKER_MODE: 'paper',
    PAPER_DEMO_DATABASE_URL: 'postgresql://hth_test:fixture@localhost/hth_readonly_test',
    LOCAL_PAPER_ACCOUNT_ID: 'paper-demo-local',
  };
  const command = workerCommand(parseWorkerServiceConfig(env))!;
  expect(command).toEqual(['paper-service-run.js', '--account=paper-demo-local']);
  expect(command.join(' ')).not.toMatch(/--resume|--prepare|--initialize/);
  expect(() => parseWorkerServiceConfig({ ...env, LOCAL_PAPER_ACCOUNT_ID: 'paper-market-other' })).toThrow();
  expect(() =>
    parseWorkerServiceConfig({ ...env, PAPER_DEMO_DATABASE_URL: 'postgresql://hth_test:fixture@db/hth_readonly_test' }),
  ).toThrow();
});
it('실제 원천 관측도 재개 없이 한 시장 정규장과 공유 잠금 경로만 사용한다', () => {
  const env = {
    WORKER_MODE: 'observe',
    WORKER_SOURCE: 'toss-readonly',
    WORKER_REQUEST_ID: randomUUID(),
    WORKER_SYMBOLS: 'US:AAPL',
    TOSS_CLIENT_ID: 'fixture',
    TOSS_CLIENT_SECRET: 'fixture',
    DATABASE_URL: 'postgresql://hth:fixture@localhost/hth_trading',
  };
  const command = workerCommand(parseWorkerServiceConfig(env))!;
  expect(command).toContain('--regular-only');
  expect(command).toContain('--share-dashboard');
  expect(command).not.toContain('--resume');
  expect(() => parseWorkerServiceConfig({ ...env, WORKER_SYMBOLS: 'KR:005930,US:AAPL' })).toThrow();
});
