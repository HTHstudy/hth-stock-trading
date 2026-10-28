import { expect, it } from 'vitest';
import example from '../../../examples/paper-risk-input.json' with { type: 'json' };
import { createRiskDemo } from './risk-demo-model.js';

it('합성 시나리오로 보유분 보호·미체결 예약·장애 차단과 정지 무효화를 재현한다', () => {
  const report = createRiskDemo(example);
  expect(report).toMatchObject({
    executionEnabled: false,
    notAnOrderApproval: true,
    initialStopped: true,
    currentBeforeStop: true,
    currentAfterStop: false,
  });
  expect(report.results).toHaveLength(12);
  expect(report.results.filter((result) => result.canReserve).map((result) => result.scenario)).toEqual([
    'ELIGIBLE_SYNTHETIC_BUY',
    'OWN_STRATEGY_SELL',
  ]);
  expect(report.results.find((result) => result.scenario === 'MANUAL_POSITION_PROTECTED')?.blockers).toContain(
    'INSUFFICIENT_OWNED_QUANTITY',
  );
  expect(report.results.find((result) => result.scenario === 'PENDING_CASH_RESERVED')?.blockers).toContain(
    'INSUFFICIENT_CASH',
  );
  expect(JSON.stringify(report)).not.toContain('synthetic-account');
});
