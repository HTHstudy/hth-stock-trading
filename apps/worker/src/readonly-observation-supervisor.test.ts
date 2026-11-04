import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { contentHash } from '@hth/database';
import type { ObservationChildLauncher } from './readonly-process-check.js';
import { fingerprintObservationBuild } from './readonly-process-check.js';
import { runReadonlySupervisor } from './readonly-observation-supervisor.js';
import { parseReadonlySupervisor } from './readonly-supervisor-config.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
async function setup() {
  const outputRoot = await mkdtemp(join(tmpdir(), 'readonly-supervisor-'));
  roots.push(outputRoot);
  const clock = { now: Date.now() - 1000 };
  const args = [
    '--kind=expiry',
    `--start-at=${new Date(clock.now).toISOString()}`,
    `--deadline=${new Date(clock.now + 360000).toISOString()}`,
    '--interval-seconds=10',
    '--ttl-seconds=1',
  ];
  const preview = await runReadonlySupervisor(args, {}, '/not-used', new AbortController().signal);
  if (!('planHash' in preview)) throw Error('Missing preview');
  return {
    outputRoot,
    clock,
    args: [
      ...args,
      '--execute',
      `--plan-hash=${preview.planHash}`,
      `--build-hash=${await fingerprintObservationBuild(resolve('.'))}`,
    ],
  };
}
it('기본 미리보기는 빌드/키/DB/프로세스에 접근하지 않으며 위험하거나 중복된 옵션을 거부한다', async () => {
  const launch = vi.fn();
  expect(await runReadonlySupervisor([], {}, '/not-used', new AbortController().signal, { launch })).toMatchObject({
    state: 'preview',
    source: 'demo',
    scheduled: false,
    executionEnabled: false,
  });
  expect(launch).not.toHaveBeenCalled();
  for (const args of [
    ['--resume'],
    ['--output=/tmp'],
    ['--execute'],
    ['--source=market'],
    ['--source=demo', '--symbol=US:AAPL'],
    ['--kind=expiry', '--kind=session'],
  ])
    expect(() => parseReadonlySupervisor(args, {})).toThrow();
  expect(() => parseReadonlySupervisor([], { TRADING_MODE: 'live' })).toThrow();
});
it('계획/빌드 hash 변경과 만료된 시작은 자식 실행 전에 거부한다', async () => {
  const f = await setup(),
    launch = vi.fn();
  for (const args of [
    f.args.map((arg) => (arg.startsWith('--plan-hash=') ? '--plan-hash=bad' : arg)),
    f.args.map((arg) => (arg.startsWith('--build-hash=') ? `--build-hash=${'0'.repeat(64)}` : arg)),
  ])
    await expect(
      runReadonlySupervisor(args, {}, resolve('.'), new AbortController().signal, {
        launch,
        outputRoot: f.outputRoot,
        now: () => f.clock.now,
      }),
    ).rejects.toThrow();
  await expect(
    runReadonlySupervisor(f.args, {}, resolve('.'), new AbortController().signal, {
      launch,
      outputRoot: f.outputRoot,
      now: () => f.clock.now + 121000,
    }),
  ).rejects.toThrow('SUPERVISOR_START_MISSED');
  expect(launch).not.toHaveBeenCalled();
  expect(await readdir(f.outputRoot)).toEqual([]);
});
it.each([false, true])(
  '기한에는 소유 자식만 정리하며 강제 종료=%s를 정상 완료로 바꾸지 않는다',
  async (forced) => {
    const f = await setup();
    const launch = vi.fn<ObservationChildLauncher>(() => {
      const child = spawn(
        process.execPath,
        ['-e', `process.on('SIGTERM',()=>{${forced ? '' : 'process.exit(0)'}});setInterval(()=>{},1000)`],
        { stdio: 'ignore', env: {} },
      );
      setTimeout(() => {
        f.clock.now += 301000;
      }, 300);
      return child;
    });
    const result = await runReadonlySupervisor(f.args, {}, resolve('.'), new AbortController().signal, {
      outputRoot: f.outputRoot,
      launch,
      now: () => f.clock.now,
      pollMs: 20,
      graceMs: forced ? 40 : 2000,
      killMs: 2000,
    });
    expect(result).toMatchObject({
      state: 'failed',
      code: forced ? 'SUPERVISOR_FORCED_STOP' : 'SUPERVISOR_DEADLINE',
      forced,
      childCleanupConfirmed: !forced,
      evidence: null,
      automaticRetry: false,
    });
    expect(launch).toHaveBeenCalledTimes(1);
  },
  10000,
);
it('대기 중 취소하면 자식이나 후속 실행을 시작하지 않는다', async () => {
  const f = await setup(),
    controller = new AbortController(),
    launch = vi.fn();
  setTimeout(() => controller.abort(), 100);
  const result = await runReadonlySupervisor(f.args, {}, resolve('.'), controller.signal, {
    launch,
    outputRoot: f.outputRoot,
    now: () => f.clock.now - 10000,
  });
  expect(result).toMatchObject({
    state: 'failed',
    stage: 'waiting',
    code: 'SUPERVISOR_CANCELLED',
    childCleanupConfirmed: true,
  });
  expect(launch).not.toHaveBeenCalled();
});
it('시계 역행과 증거 없는 정상 exit도 실패이며 비밀 설정을 자식에 전달하지 않는다', async () => {
  const f = await setup();
  const launch = vi.fn<ObservationChildLauncher>((command, args, options) => {
    expect(args).not.toEqual(expect.arrayContaining([expect.stringMatching(/^--env-file/)]));
    expect(options.env).not.toHaveProperty('NODE_OPTIONS');
    expect(options.env).not.toHaveProperty('TOSS_CLIENT_SECRET');
    return spawn(command, ['-e', 'process.exit(0)'], options);
  });
  const result = await runReadonlySupervisor(
    f.args,
    { NODE_OPTIONS: 'SECRET', TOSS_CLIENT_SECRET: 'SECRET' },
    resolve('.'),
    new AbortController().signal,
    { launch, outputRoot: f.outputRoot, now: () => f.clock.now },
  );
  expect(result).toMatchObject({ state: 'failed', code: 'SUPERVISOR_EVIDENCE_INVALID', childCleanupConfirmed: true });
  expect(JSON.stringify(result)).not.toMatch(/SECRET|pid|postgres|\/private\//);
  const second = await setup();
  const backwards = vi.fn<ObservationChildLauncher>(() => {
    const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore', env: {} });
    second.clock.now--;
    return child;
  });
  expect(
    await runReadonlySupervisor(second.args, {}, resolve('.'), new AbortController().signal, {
      launch: backwards,
      outputRoot: second.outputRoot,
      now: () => second.clock.now,
    }),
  ).toMatchObject({ state: 'failed', code: 'SUPERVISOR_CLOCK_CHANGED' });
});
it.each([false, true])('합성 증거 연결과 hash 변조=%s를 검증하고 갱신/세션 승인과 구분한다', async (tamper) => {
  const f = await setup();
  const launch: ObservationChildLauncher = (command, args, options) => {
    const parent = args.find((arg) => arg.startsWith('--output='))!.slice(9);
    const count = Number(args.find((arg) => arg.startsWith('--samples='))!.slice(10));
    const script = `
      import {createObservationFiles} from './apps/worker/dist/market-observation-files.js';
      import {runMarketObservation} from './apps/worker/dist/market-observation.js';
      import {createPaperSyntheticSource} from './apps/worker/dist/paper-synthetic-source.js';
      import {readFile,writeFile} from 'node:fs/promises';
      const config={source:'synthetic-only',instruments:[{market:'KR',symbol:'005930'}],samples:${count},intervalMs:10000,timeoutMs:10000};
      const files=await createObservationFiles(${JSON.stringify(parent)},config);
      let clock=Date.now()+100;
      const summary=await runMarketObservation(config,{createSource:()=>createPaperSyntheticSource(21),record:r=>files.record(r),now:()=>clock,wait:async ms=>{clock+=ms;}},new AbortController().signal);
      await files.finish(summary);
      const path=files.directory+'/summary.json',terminal=JSON.parse(await readFile(path,'utf8'));
      terminal.finishedAt=new Date(clock).toISOString();
      if(${tamper})terminal.journalSha256='0'.repeat(64);
      await writeFile(path,JSON.stringify(terminal));
    `;
    const child = spawn(command, ['--input-type=module', '-e', script], options);
    child.once('close', () => {
      f.clock.now += 200000;
    });
    return child;
  };
  const result = await runReadonlySupervisor(f.args, {}, resolve('.'), new AbortController().signal, {
    launch,
    outputRoot: f.outputRoot,
    now: () => f.clock.now,
  });
  expect(result).toMatchObject({
    state: tamper ? 'failed' : 'observation-completed',
    tokenExpiryVerified: false,
    sessionBoundaryVerified: false,
    paperLedgerCompared: false,
    childCleanupConfirmed: true,
  });
  if (!tamper) expect(result).toMatchObject({ evidence: { samples: 14 } });
  if (!('id' in result)) throw Error('Missing result');
  const path = join(f.outputRoot, result.id, 'result.json');
  const { hash, ...body } = JSON.parse(await readFile(path, 'utf8'));
  expect(hash).toBe(contentHash(body));
  expect((await stat(path)).mode & 0o777).toBe(0o600);
});
