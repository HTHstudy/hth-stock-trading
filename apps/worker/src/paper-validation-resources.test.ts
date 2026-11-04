import { mkdtemp, mkdir, copyFile, symlink, writeFile, readFile, rm, stat, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { afterEach, expect, it, vi } from 'vitest';
import { contentHash } from '@hth/database';
import { defaultPaperMarketPlan } from './paper-market-plan.js';
import type { runPaperPreparation } from './paper-preparation.js';
import {
  createPaperValidationResources,
  verifyPaperValidationResources,
  checkPaperValidationPreparation,
  paperValidationFailureCode,
} from './paper-validation-resources.js';
import { runPaperValidationPreflight } from './paper-validation-preflight.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'paper-validation-resource-'));
  roots.push(root);
  const plan = defaultPaperMarketPlan({ market: 'US', symbol: 'AAPL' }),
    source = join(root, 'source.json');
  await writeFile(source, JSON.stringify(plan));
  return { root, plan, source, planHash: contentHash(plan) };
}
it('계획 파일 없는 고정 빌드의 오류를 재현하고 고정 입력의 절대 경로로 해결한다', async () => {
  const f = await fixture(),
    build = join(f.root, 'relocated'),
    src = join(build, 'apps/worker/dist');
  await mkdir(src, { recursive: true });
  await writeFile(join(build, 'package.json'), '{"type":"module"}');
  for (const name of ['paper-market-plan', 'paper-preparation', 'paper-preparation-query'])
    for (const extension of ['js', 'js.map'])
      await copyFile(resolve(`apps/worker/dist/${name}.${extension}`), join(src, `${name}.${extension}`));
  await mkdir(join(build, 'apps/worker/src'));
  for (const name of ['paper-market-plan', 'paper-preparation', 'paper-preparation-query'])
    await copyFile(resolve(`apps/worker/src/${name}.ts`), join(build, 'apps/worker/src', `${name}.ts`));
  await symlink(fileURLToPath(new URL('../node_modules', import.meta.url)), join(build, 'apps/worker/node_modules'));
  const isolated: { runPaperPreparation: typeof runPaperPreparation } = await import(
    pathToFileURL(join(src, 'paper-preparation.js')).href
  );
  const openDatabase = vi.fn(() => {
      throw new Error('DATABASE_REACHED');
    }),
    assertDatabase = vi.fn(),
    migrate = vi.fn();
  const check: typeof runPaperPreparation = (args, env) =>
    isolated.runPaperPreparation(args, env, { openDatabase, assertDatabase, migrate });
  await expect(
    check(
      [
        '--check',
        '--plan=examples/paper-market-us-validation-v1.json',
        `--plan-hash=${f.planHash}`,
        '--account=paper-market-fixture',
      ],
      { TRADING_MODE: 'paper' },
    ),
  ).rejects.toThrow('PAPER_MARKET_PLAN_INVALID');
  expect(openDatabase).not.toHaveBeenCalled();
  const pinned = await createPaperValidationResources(join(f.root, 'inputs'), 'US', f.source, f.planHash);
  await expect(
    checkPaperValidationPreparation(
      { ...pinned, market: 'US', accountId: 'paper-market-fixture' },
      { TRADING_MODE: 'paper', PAPER_MARKET_DATABASE_URL: 'postgresql://hth_test@127.0.0.1:55434/hth_readonly_test' },
      { check },
    ),
  ).rejects.toThrow('DATABASE_REACHED');
  expect(openDatabase).toHaveBeenCalledOnce();
  expect(migrate).not.toHaveBeenCalled();
});
it('원본 변경과 이동한 모듈 위치에 영향받지 않는 새 입력·hash·권한을 보존한다', async () => {
  const f = await fixture(),
    pinned = await createPaperValidationResources(join(f.root, 'inputs'), 'US', f.source, f.planHash);
  await writeFile(f.source, 'PRIVATE_CHANGED_INPUT');
  const verified = await verifyPaperValidationResources(pinned.directory, pinned.resourcesHash, 'US');
  expect(JSON.parse(await readFile(verified.planPath, 'utf8'))).toEqual(f.plan);
  expect((await stat(verified.planPath)).mode & 0o777).toBe(0o600);
  expect((await stat(pinned.directory)).mode & 0o777).toBe(0o700);
  expect(await readdir(pinned.directory)).toEqual(expect.arrayContaining(['plan.json', 'manifest.json']));
});
it('잘못된 원본 hash·시장·상대 경로는 입력 파일 생성 전에 차단한다', async () => {
  const f = await fixture(),
    parent = join(f.root, 'never-created');
  for (const operation of [
    () => createPaperValidationResources(parent, 'US', f.source, '0'.repeat(64)),
    () => createPaperValidationResources(parent, 'KR', f.source, f.planHash),
    () => createPaperValidationResources(parent, 'US', 'relative.json', f.planHash),
  ])
    await expect(operation()).rejects.toThrow();
  expect(await readdir(f.root)).toEqual(['source.json']);
});
it('변조·누락·symlink·다른 시장은 DB 점검 전에 거부한다', async () => {
  const f = await fixture(),
    pinned = await createPaperValidationResources(join(f.root, 'inputs'), 'US', f.source, f.planHash);
  const check = vi.fn<typeof runPaperPreparation>();
  await expect(
    checkPaperValidationPreparation({ ...pinned, market: 'KR', accountId: 'paper-market-fixture' }, {}, { check }),
  ).rejects.toThrow('PAPER_VALIDATION_RESOURCE_INVALID');
  await writeFile(join(pinned.directory, 'plan.json'), JSON.stringify({ ...f.plan, cash: { KRW: '1', USD: '999' } }));
  await expect(
    checkPaperValidationPreparation({ ...pinned, market: 'US', accountId: 'paper-market-fixture' }, {}, { check }),
  ).rejects.toThrow('PAPER_MARKET_PLAN_HASH_MISMATCH');
  await rm(join(pinned.directory, 'plan.json'));
  await symlink(f.source, join(pinned.directory, 'plan.json'));
  await expect(verifyPaperValidationResources(pinned.directory, pinned.resourcesHash, 'US')).rejects.toThrow(
    'PAPER_VALIDATION_RESOURCE_INVALID',
  );
  expect(check).not.toHaveBeenCalled();
});
it('안전 오류 코드는 보존하고 원문·계좌·경로는 일반 코드로 제거한다', () => {
  for (const code of [
    'PAPER_MARKET_PLAN_INVALID',
    'PAPER_MARKET_PLAN_HASH_MISMATCH',
    'PAPER_VALIDATION_RESOURCE_INVALID',
  ])
    expect(paperValidationFailureCode(new Error(code))).toBe(code);
  expect(paperValidationFailureCode(new Error('PRIVATE_SECRET /account/path'))).toBe('PAPER_VALIDATION_NOT_COMPLETED');
  expect(paperValidationFailureCode(new Error('PRIVATE'), true)).toBe('CANCELLED');
});
it('CLI 미리보기는 파일·키·DB 없이 가능하며 체크에 쓰기·재개 옵션을 섞지 못한다', async () => {
  expect(await runPaperValidationPreflight([], {})).toMatchObject({ state: 'preview', canResume: false });
  for (const args of [['--resume'], ['--pin', '--check'], ['--check', '--market=US', '--plan=/private/unknown']])
    await expect(runPaperValidationPreflight(args, {})).rejects.toThrow();
  await expect(runPaperValidationPreflight([], { TRADING_MODE: 'live' })).rejects.toThrow();
});
