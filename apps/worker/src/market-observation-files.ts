import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { observationRecordSchema, observationFailureCode } from './market-observation.js';
import type { ObservationConfig, ObservationSummary } from './market-observation.js';

export async function createObservationFiles(parent: string, config: ObservationConfig) {
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const id = randomUUID();
  const directory = join(parent, id);
  await mkdir(directory, { mode: 0o700 });
  const manifest = {
    formatVersion: 'market-observation-v1',
    id,
    startedAt: new Date().toISOString(),
    mode: 'paper',
    assessmentScope: 'market-data-only',
    executionEnabled: false,
    policyVersion: 'market-data-v1',
    source: config.source,
    instruments: config.instruments.map(({ market, symbol }) => ({ market, symbol })),
    samples: config.samples,
    intervalMs: config.intervalMs,
    timeoutMs: config.timeoutMs,
  };
  await writeFile(join(directory, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, {
    flag: 'wx',
    mode: 0o600,
  });
  const journal = await open(join(directory, 'samples.jsonl'), 'wx', 0o600);
  const hash = createHash('sha256');
  let closed = false;
  return {
    id,
    directory,
    async record(value: unknown) {
      if (closed) throw new Error('OBSERVATION_FILES_CLOSED');
      const line = `${JSON.stringify(observationRecordSchema.parse(value))}\n`;
      await journal.writeFile(line);
      await journal.sync();
      hash.update(line);
    },
    async finish(summary: ObservationSummary) {
      if (closed) throw new Error('OBSERVATION_FILES_CLOSED');
      closed = true;
      await journal.close();
      const report = { ...manifest, finishedAt: new Date().toISOString(), journalSha256: hash.digest('hex'), summary };
      await writeFile(join(directory, 'summary.json.tmp'), `${JSON.stringify(report, null, 2)}\n`, {
        flag: 'wx',
        mode: 0o600,
      });
      await rename(join(directory, 'summary.json.tmp'), join(directory, 'summary.json'));
      const counts = (values: Record<string, number>) =>
        Object.entries(values)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([code, count]) => `| ${code} | ${count} |`)
          .join('\n') || '| 없음 | 0 |';
      const instruments =
        Object.entries(summary.instruments)
          .map(
            ([symbol, item]) =>
              `| ${symbol} | ${item.samples} | ${item.healthy} | ${item.closed} | ${item.blocked} | ${item.quoteRegressions} | ${item.missingQuoteTimes} | ${item.maxQuoteAgeMs ?? '-'} |`,
          )
          .join('\n') || '| 없음 | 0 | 0 | 0 | 0 | 0 | 0 | - |';
      await writeFile(
        join(directory, 'report.md'),
        `# 시세 관측 리포트\n\n- 출처: ${config.source}\n- 범위: 시장 데이터만 검사, 계좌·전략·리스크 실행 승인 제외\n- 상태: ${summary.status} (수집 종료 상태이며 운용 합격 판정이 아님)\n- 관측: ${summary.samples}/${config.samples}, 수집 성공 ${summary.successfulSamples}, 수집 오류 ${summary.errorSamples}\n- 종목 관측 수: 정상 ${summary.healthy}, 정규장 밖/휴장 ${summary.closed}, 차단 ${summary.blocked}\n- 시세 시각 퇴행: ${summary.quoteRegressions}\n- 평균/최대 수집 시간(ms): ${summary.samples ? (summary.totalDurationMs / summary.samples).toFixed(1) : '0'}/${summary.maxDurationMs.toFixed(1)}\n- 샘플 SHA-256: ${report.journalSha256}\n\n## 종목별 관측\n\n| 종목 | 관측 | 정상 | 휴장/정규장 밖 | 차단 | 퇴행 | 시각 누락 | 최대 시세 지연(ms) |\n| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |\n${instruments}\n\n## 데이터 차단 사유\n\n| 코드 | 종목 관측 수 |\n| --- | ---: |\n${counts(summary.blockers)}\n\n## 수집 오류\n\n| 코드 | 횟수 |\n| --- | ---: |\n${counts(summary.errors)}\n\n휴장 관측에도 지연·미확인 시각 등 차단 사유를 보존합니다. 합성 관측은 실제 시장 운영 검증이 아닙니다. 가격·원본 캔들·계좌·인증 정보는 이 리포트에 포함하지 않습니다.\n`,
        { flag: 'wx', mode: 0o600 },
      );
    },
    async fail(error: unknown) {
      if (closed) return;
      closed = true;
      await journal.close();
      const code = observationFailureCode(error);
      const failure = {
        ...manifest,
        finishedAt: new Date().toISOString(),
        journalSha256: hash.digest('hex'),
        failure: { code },
        summary: null,
      };
      await writeFile(join(directory, 'failure.json.tmp'), `${JSON.stringify(failure, null, 2)}\n`, {
        flag: 'wx',
        mode: 0o600,
      });
      await rename(join(directory, 'failure.json.tmp'), join(directory, 'failure.json'));
      await writeFile(
        join(directory, 'report.md'),
        `# 시세 관측 중단\n\n출처: ${config.source}\n\n오류 코드: ${code}\n\n완료 요약이 없습니다. samples.jsonl에 저장된 관측만 유효하며, 정상 관측이나 운영 검증 완료를 의미하지 않습니다. 거래는 실행하지 않았습니다.\n`,
        { flag: 'wx', mode: 0o600 },
      );
    },
    async close() {
      if (!closed) {
        closed = true;
        await journal.close();
      }
    },
  };
}
