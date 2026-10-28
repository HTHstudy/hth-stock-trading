import { expect, it } from 'vitest';
import { paperRiskInputSchema } from '@hth/contracts';
import example from '../../../../examples/paper-risk-input.json' with { type: 'json' };
import { settlePaperFill } from './paper-fill.js';
import type { PaperFillInput } from './paper-fill.js';

function fixture(): PaperFillInput {
  const input = paperRiskInputSchema.parse(structuredClone(example));
  const { intentId, strategyId, instrument, side } = input.candidate;
  return {
    snapshot: {
      ...input.snapshot!,
      reservations: [
        {
          intentId,
          strategyId,
          instrument,
          side,
          remainingQuantity: '10',
          limitPrice: '1000',
          costBps: '10',
          filledNotional: '0',
          paidCosts: '0',
        },
      ],
    },
    candidate: input.candidate,
    quantity: '4',
    quote: { price: '1000', timestamp: input.asOf, observedAt: input.asOf },
    cumulative: { quantity: '0', notional: '0', costs: '0' },
    basis: null,
    asOf: input.asOf,
    maxDailyLoss: '10000',
  };
}
function next(input: PaperFillInput, quantity: string) {
  const settled = settlePaperFill(input)!;
  const previous = input.snapshot.reservations[0]!;
  input.snapshot = {
    ...input.snapshot,
    ...settled.ledger,
    reservations: [
      {
        ...previous,
        remainingQuantity: settled.remainingQuantity,
        filledNotional: settled.filledNotional,
        paidCosts: settled.paidCosts,
      },
    ],
  };
  input.basis = settled.basis;
  input.cumulative = { quantity: settled.filledQuantity, notional: settled.filledNotional, costs: settled.paidCosts };
  input.quantity = quantity;
  return settled;
}
it('부분 매수는 비용 포함 현금과 전략 소유분만 갱신하고 입력을 변경하지 않는다', () => {
  const input = fixture();
  const original = structuredClone(input);
  const result = settlePaperFill(input)!;
  expect(input).toEqual(original);
  expect(result).toMatchObject({
    filledQuantity: '4',
    costs: '4',
    remainingCash: '6006',
    basis: { quantity: '4', amount: '4004' },
  });
  expect(result.ledger.positions[0]).toMatchObject({
    quantity: '4',
    manualQuantity: '0',
    ownership: [{ strategyId: input.candidate.strategyId, quantity: '4' }],
  });
  expect(result.ledger.dailyPnl.KRW.netPnl).toBe('-4');
});
it('USD 부분 체결 수수료는 주문 누적 대금 기준으로 한 번만 센트 올림한다', () => {
  const input = fixture();
  input.candidate = {
    ...input.candidate,
    instrument: { market: 'US', symbol: 'AAPL' },
    limitPrice: '0.01',
    quantity: '2',
  };
  input.snapshot.reservations[0] = {
    ...input.snapshot.reservations[0]!,
    instrument: input.candidate.instrument,
    limitPrice: '0.01',
    remainingQuantity: '2',
  };
  input.quote.price = '0.01';
  input.snapshot.dailyPnl.USD.tradingDate = '2026-03-25';
  input.quantity = '1';
  const first = next(input, '1');
  expect(first).toMatchObject({ costs: '0.01', paidCosts: '0.01', remainingCash: '0.01', basis: { amount: '0.02' } });
  const second = settlePaperFill(input)!;
  expect(second).toMatchObject({
    costs: '0',
    paidCosts: '0.01',
    remainingCash: '0',
    basis: { quantity: '2', amount: '0.03' },
  });
  input.quantity = '1';
  input.snapshot = { ...input.snapshot, ...second.ledger };
  input.basis = second.basis;
  input.candidate = { ...input.candidate, side: 'SELL' };
  input.cumulative = { quantity: '0', notional: '0', costs: '0' };
  input.snapshot.reservations[0] = {
    ...input.snapshot.reservations[0]!,
    side: 'SELL',
    remainingQuantity: '2',
    costBps: '0',
    filledNotional: '0',
    paidCosts: '0',
  };
  expect(next(input, '1').basis).toEqual({ quantity: '1', amount: '0.02' });
  expect(settlePaperFill(input)!).toMatchObject({ basis: { quantity: '0', amount: '0' }, realizedPnl: '-0.01' });
});
it('지정가 조건과 통화 단위에 맞게 불리한 방향으로 가격을 반올림한다', () => {
  const input = fixture();
  input.quote.price = '1000.01';
  expect(settlePaperFill(input)).toBeNull();
  input.quote.price = '999.01';
  expect(settlePaperFill(input)!.price).toBe('1000');
});
it('보유 원가가 없거나 잔여 주문량을 넘는 체결은 거부한다', () => {
  const input = fixture();
  next(input, '7');
  expect(() => settlePaperFill(input)).toThrow('PAPER_FILL_QUANTITY_INVALID');
  input.quantity = '1';
  input.basis = null;
  expect(() => settlePaperFill(input)).toThrow('PAPER_BASIS_MISMATCH');
});
it('매도는 자기 전략 보유분의 원가만 해제하고 이미 평가한 이익을 일일 손익에 중복 반영하지 않는다', () => {
  const input = fixture();
  const bought = next(input, '4');
  const position = input.snapshot.positions[0]!;
  position.quantity = '104';
  position.manualQuantity = '100';
  position.sellableQuantity = '104';
  input.candidate = { ...input.candidate, side: 'SELL', quantity: '4' };
  input.snapshot.reservations[0] = {
    ...input.snapshot.reservations[0]!,
    side: 'SELL',
    remainingQuantity: '4',
    costBps: '30',
    filledNotional: '0',
    paidCosts: '0',
  };
  input.cumulative = { quantity: '0', notional: '0', costs: '0' };
  const sold = settlePaperFill(input)!;
  expect(sold).toMatchObject({ realizedPnl: '-16', basis: { quantity: '0', amount: '0' }, remainingSell: '0' });
  expect(sold.ledger.dailyPnl.KRW.netPnl).toBe('-16');
  expect(sold.ledger.positions[0]).toMatchObject({ quantity: '100', manualQuantity: '100', ownership: [] });
  expect(bought.basis.amount).toBe('4004');
});
it('이미 평가한 시세 이익의 매도는 일일 손익에 수수료만 추가한다', () => {
  const input = fixture();
  next(input, '4');
  input.snapshot.positions[0]!.markPrice = '1100';
  input.snapshot.dailyPnl.KRW.netPnl = '396';
  input.candidate = { ...input.candidate, side: 'SELL', quantity: '4' };
  input.snapshot.reservations[0] = {
    ...input.snapshot.reservations[0]!,
    side: 'SELL',
    remainingQuantity: '4',
    costBps: '30',
    filledNotional: '0',
    paidCosts: '0',
  };
  input.cumulative = { quantity: '0', notional: '0', costs: '0' };
  input.quote.price = '1100';
  expect(settlePaperFill(input)!).toMatchObject({
    realizedPnl: '382',
    ledger: { dailyPnl: { KRW: { netPnl: '382' } } },
  });
});
it('다른 주문의 현금 예약과 손실 한도를 침범하지 않는다', () => {
  const input = fixture();
  input.snapshot.cash.KRW = '10000';
  expect(() => settlePaperFill(input)).toThrow('PAPER_INSUFFICIENT_CASH');
  input.snapshot.reservations.push({
    ...input.snapshot.reservations[0]!,
    intentId: 'other-buy',
    instrument: { market: 'KR', symbol: '005380' },
    remainingQuantity: '5',
  });
  input.snapshot.cash.KRW = '15014';
  expect(() => settlePaperFill(input)).toThrow('PAPER_INSUFFICIENT_CASH');
  input.snapshot.cash.KRW = '15015';
  expect(settlePaperFill(input)!.ledger.cash.KRW).toBe('11011');
  input.snapshot.reservations.pop();
  input.snapshot.cash.KRW = '15000';
  input.maxDailyLoss = '10';
  expect(() => settlePaperFill(input)).toThrow('PAPER_DAILY_LOSS_LIMIT');
});
