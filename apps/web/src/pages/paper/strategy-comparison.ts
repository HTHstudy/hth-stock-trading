import type { PaperStrategyHistory } from '@hth/contracts';
type Configuration = Pick<PaperStrategyHistory['strategy'], 'version' | 'enabled' | 'definition'>;
function fields(value: Configuration): [string, string][] {
  const definition = value.definition;
  return [
    ['구현 버전', value.version],
    ['등록 활성', value.enabled ? '활성' : '비활성'],
    ['시장·종목', definition ? `${definition.instrument.market}:${definition.instrument.symbol}` : '미등록'],
    ['단기 기간', definition ? String(definition.parameters.fastPeriod) : '미등록'],
    ['장기 기간', definition ? String(definition.parameters.slowPeriod) : '미등록'],
    ['주문 수량', definition ? definition.quantity : '미등록'],
    ['관측당 최대 체결', definition ? definition.maxFillQuantity : '미등록'],
  ];
}
export function strategyComparison(previous: Configuration, current: Configuration) {
  const old = fields(previous);
  return fields(current).map(([label, after], index) => ({
    label,
    before: old[index]![1],
    after,
    changed: old[index]![1] !== after,
  }));
}
