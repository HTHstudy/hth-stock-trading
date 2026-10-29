import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { BrokerError } from '@hth/broker';
import { createObservationFiles } from './market-observation-files.js';
import { runMarketObservation } from './market-observation.js';
import type { ObservationConfig } from './market-observation.js';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
const config: ObservationConfig = {
  source: 'toss-readonly',
  instruments: [{ market: 'KR', symbol: '005930' }],
  samples: 1,
  intervalMs: 0,
  timeoutMs: 100,
};
async function fixture() {
  const parent = await mkdtemp(join(tmpdir(), 'hth-observation-'));
  directories.push(parent);
  const expanded = {
    ...config,
    clientSecret: 'PRIVATE_SECRET_DO_NOT_STORE',
    accountNumber: 'PRIVATE_ACCOUNT_DO_NOT_STORE',
  };
  return createObservationFiles(parent, expanded);
}
it('각 기록을 저장하고 해시·요약을 만들며 인증/계좌 필드를 포함하지 않는다', async () => {
  const files = await fixture();
  try {
    const summary = await runMarketObservation(
      config,
      {
        createSource: () => async () => {
          throw new BrokerError('AUTHENTICATION_FAILED');
        },
        record: files.record,
      },
      new AbortController().signal,
    );
    await files.finish(summary);
    const journal = await readFile(join(files.directory, 'samples.jsonl'), 'utf8');
    const report = JSON.parse(await readFile(join(files.directory, 'summary.json'), 'utf8'));
    expect(report.summary).toMatchObject({ status: 'failed', samples: 1, errorSamples: 1 });
    expect(report.assessmentScope).toBe('market-data-only');
    expect(report.journalSha256).toBe(createHash('sha256').update(journal).digest('hex'));
    expect((await stat(files.directory)).mode & 0o777).toBe(0o700);
    for (const name of await readdir(files.directory)) {
      expect((await stat(join(files.directory, name))).mode & 0o777).toBe(0o600);
      expect(await readFile(join(files.directory, name), 'utf8')).not.toMatch(
        /PRIVATE_SECRET|PRIVATE_ACCOUNT|clientSecret|accountNumber/,
      );
    }
    expect(JSON.parse(journal).error).toBe('AUTHENTICATION_FAILED');
  } finally {
    await files.close();
  }
});
it('중도 실패는 미완료 결과로 표시하고 원문 예외는 기록하지 않는다', async () => {
  const files = await fixture();
  await files.fail(new Error('PRIVATE_KEY_RAW_RESPONSE'));
  const failure = JSON.parse(await readFile(join(files.directory, 'failure.json'), 'utf8'));
  expect(failure.failure).toEqual({ code: 'OBSERVATION_FAILED' });
  expect(failure.summary).toBeNull();
  expect(JSON.stringify(failure)).not.toContain('PRIVATE_KEY');
  expect(await readdir(files.directory)).not.toContain('summary.json');
  await files.close();
});
it('중간 종료에는 완료 요약을 꾸미지 않으며 비공개 필드를 가진 기록을 거부한다', async () => {
  const files = await fixture();
  await expect(
    files.record({
      index: 1,
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      durationMs: 0,
      error: null,
      instruments: [],
      rawAccount: 'PRIVATE',
    }),
  ).rejects.toThrow();
  await files.close();
  expect(await readFile(join(files.directory, 'samples.jsonl'), 'utf8')).toBe('');
  expect(await readdir(files.directory)).toEqual(expect.arrayContaining(['manifest.json', 'samples.jsonl']));
  expect(await readdir(files.directory)).not.toContain('summary.json');
});
