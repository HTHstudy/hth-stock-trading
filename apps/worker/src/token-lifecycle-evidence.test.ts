import { mkdtemp, readFile, readdir, stat, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';
import { createTossReadonlyBroker } from '@hth/broker/toss';
import { contentHash } from '@hth/database';
import { createObservationFiles } from './market-observation-files.js';
import { verifyTokenLifecycleEvidence } from './token-lifecycle-evidence.js';

const config = {
  source: 'toss-readonly' as const,
  instruments: [{ market: 'KR' as const, symbol: '005930' }],
  samples: 1,
  intervalMs: 60000,
  timeoutMs: 10000,
};
function emptySnapshot() {
  return createTossReadonlyBroker({
    clientId: 'PRIVATE_CLIENT',
    clientSecret: 'PRIVATE_SECRET',
    fetch: async () => {
      throw new Error('NO_NETWORK_EXPECTED');
    },
  }).readTokenLifecycle();
}
it('명시적 계측 파일만 원자적으로 보관하고 manifest·hash·권한·덮어쓰기 방지를 확인한다', async () => {
  const root = await mkdtemp(join(tmpdir(), 'token-lifecycle-'));
  const files = await createObservationFiles(root, config);
  try {
    expect(await readdir(files.directory)).not.toContain('token-lifecycle.json');
    const snapshot = emptySnapshot();
    await files.recordTokenLifecycle(snapshot);
    const path = join(files.directory, 'token-lifecycle.json');
    const text = await readFile(path, 'utf8'),
      artifact = JSON.parse(text),
      manifest = JSON.parse(await readFile(join(files.directory, 'manifest.json'), 'utf8'));
    expect(verifyTokenLifecycleEvidence(artifact, manifest).snapshot).toEqual(snapshot);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await stat(files.directory)).mode & 0o777).toBe(0o700);
    expect(text).not.toMatch(/PRIVATE|clientSecret|account|Bearer|Authorization|requestId/);
    await expect(files.recordTokenLifecycle(snapshot)).rejects.toThrow();
    expect(await readFile(path, 'utf8')).toBe(text);
    for (const extra of [
      { hash: '0'.repeat(64) },
      { runId: '00000000-0000-4000-8000-000000000001' },
      { token: 'PRIVATE' },
    ])
      expect(() => verifyTokenLifecycleEvidence({ ...artifact, ...extra }, manifest)).toThrow();
    expect(() => verifyTokenLifecycleEvidence(artifact, { ...manifest, samples: 2 })).toThrow();
    const { hash: oldHash, ...body } = artifact;
    expect(oldHash).toBe(contentHash(body));
    const other = { ...body, runId: '00000000-0000-4000-8000-000000000001' };
    expect(() => verifyTokenLifecycleEvidence({ ...other, hash: contentHash(other) }, manifest)).toThrow();
  } finally {
    await files.close();
    await rm(root, { recursive: true, force: true });
  }
});
it('알 수 없는 필드·모순된 집계·합성 출처를 저장하지 않는다', async () => {
  const root = await mkdtemp(join(tmpdir(), 'token-lifecycle-invalid-'));
  const files = await createObservationFiles(root, config);
  const synthetic = await createObservationFiles(root, { ...config, source: 'synthetic-only' });
  try {
    await expect(files.recordTokenLifecycle({ ...emptySnapshot(), token: 'PRIVATE' })).rejects.toThrow();
    const bad = emptySnapshot();
    bad.counters.initial.started = 1;
    await expect(files.recordTokenLifecycle(bad)).rejects.toThrow();
    await expect(synthetic.recordTokenLifecycle(emptySnapshot())).rejects.toThrow('TOKEN_LIFECYCLE_RECORD_INVALID');
    expect(await readdir(files.directory)).not.toContain('token-lifecycle.json');
  } finally {
    await files.close();
    await synthetic.close();
    await rm(root, { recursive: true, force: true });
  }
});

it('가짜 API의 발급·갱신 증거를 파일로 연결하고 계좌 응답·토큰을 복사하지 않는다', async () => {
  const root = await mkdtemp(join(tmpdir(), 'token-lifecycle-sequence-'));
  const files = await createObservationFiles(root, config);
  let now = Date.now(),
    issued = 0;
  const broker = createTossReadonlyBroker({
    clientId: 'PRIVATE',
    clientSecret: 'PRIVATE',
    now: () => now,
    wait: async (ms) => {
      now += ms;
    },
    fetch: async (url) =>
      new Response(
        JSON.stringify(
          url.endsWith('/oauth2/token')
            ? { access_token: `PRIVATE_TOKEN_${++issued}`, token_type: 'Bearer', expires_in: 120 }
            : { result: [] },
        ),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
  });
  try {
    await broker.listAccounts();
    now += 108000;
    await broker.listAccounts();
    await files.recordTokenLifecycle(broker.readTokenLifecycle());
    const artifact = JSON.parse(await readFile(join(files.directory, 'token-lifecycle.json'), 'utf8'));
    const manifest = JSON.parse(await readFile(join(files.directory, 'manifest.json'), 'utf8'));
    const result = verifyTokenLifecycleEvidence(artifact, manifest);
    expect(result.snapshot.counters.initial.succeeded).toBe(1);
    expect(result.snapshot.counters.expiry.succeeded).toBe(1);
    expect(result.canResume).toBe(false);
    expect(JSON.stringify(artifact)).not.toContain('PRIVATE');
    const changed = { ...manifest, startedAt: '2099-01-01T00:00:00Z' };
    const { hash, ...body } = artifact;
    expect(hash).toBe(contentHash(body));
    const updated = { ...body, manifestHash: contentHash(changed) };
    expect(() => verifyTokenLifecycleEvidence({ ...updated, hash: contentHash(updated) }, changed)).toThrow(
      'INVALID_TOKEN_LIFECYCLE_EVIDENCE',
    );
  } finally {
    await files.close();
    await rm(root, { recursive: true, force: true });
  }
});
