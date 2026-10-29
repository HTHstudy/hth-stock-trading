import type { PaperEquityHistory } from '@hth/contracts';
export function equityChartPoints(points: PaperEquityHistory['points'], currencyIndex: 0 | 1) {
  const result: { time: number; value: number }[] = [];
  for (const { point } of points) {
    const time = Math.floor(Date.parse(point.recordedAt) / 1000);
    const raw = point.values[currencyIndex].equity;
    const value = Number(raw);
    if (!Number.isFinite(time) || !Number.isFinite(value) || (value === 0 && /[1-9]/.test(raw))) return null;
    const previous = result.at(-1);
    if (previous && time < previous.time) return null;
    if (previous?.time === time) result[result.length - 1] = { time, value };
    else result.push({ time, value });
  }
  return result;
}
