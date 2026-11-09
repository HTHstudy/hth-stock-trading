import { useEffect, useRef } from 'react';
import { createChart, ColorType, LineSeries } from 'lightweight-charts';
import type { IChartApi, ISeriesApi, UTCTimestamp } from 'lightweight-charts';
import { getChartTheme } from '@shared/lib/chart-theme';
import { useTheme } from '@shared/lib/theme';
import type { PaperEquityHistory } from '@hth/contracts';
import { equityChartPoints } from './equity-model';
export function EquityChart({ points, currencyIndex }: { points: PaperEquityHistory['points']; currencyIndex: 0 | 1 }) {
  const element = useRef<HTMLDivElement>(null);
  const { theme } = useTheme();
  const chartInstance = useRef<{ chart: IChartApi; series: ISeriesApi<'Line'>[] } | null>(null);
  const data = equityChartPoints(points, currencyIndex);
  useEffect(() => {
    if (!element.current) return;
    const values = equityChartPoints(points, currencyIndex);
    if (!values || values.length < 2) return;
    const chart = createChart(element.current, {
      autoSize: true,
      layout: { attributionLogo: true },
      timeScale: { timeVisible: true },
      localization: {
        locale: 'ko-KR',
        timeFormatter: (time: number) => new Date(time * 1000).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' }),
      },
    });
    const series = chart.addSeries(LineSeries, {
      lineWidth: 2,
      priceFormat: { type: 'price', precision: currencyIndex === 0 ? 0 : 2, minMove: currencyIndex === 0 ? 1 : 0.01 },
    });
    chartInstance.current = { chart, series: [series] };
    series.setData(values.map(({ time, value }) => ({ time: time as UTCTimestamp, value })));
    chart.timeScale().fitContent();
    return () => {
      chartInstance.current = null;
      chart.remove();
    };
  }, [points, currencyIndex]);

  useEffect(() => {
    const instance = chartInstance.current;
    if (!instance) return;
    const palette = getChartTheme(theme);
    instance.chart.applyOptions({
      layout: { background: { type: ColorType.Solid, color: palette.background }, textColor: palette.text },
      grid: { vertLines: { color: palette.grid }, horzLines: { color: palette.grid } },
      rightPriceScale: { borderColor: palette.border },
      timeScale: { borderColor: palette.border },
      crosshair: { vertLine: { color: palette.text }, horzLine: { color: palette.text } },
    });
    instance.series.forEach((series, index) =>
      series.applyOptions({ color: index ? palette.comparisonLine : palette.line }),
    );
  }, [theme, points, currencyIndex]);
  if (!data)
    return (
      <p className="py-8 text-xs text-warning">
        차트 표시 범위나 시각 순서를 확인할 수 없습니다. 정확한 값은 표에서 확인하세요.
      </p>
    );
  if (data.length < 2)
    return <p className="py-8 text-xs text-subtle">서로 다른 시각의 평가 기록이 2개 이상 쌓이면 추이를 표시합니다.</p>;
  return (
    <div
      ref={element}
      className="h-64 w-full"
      role="img"
      aria-label="선택 통화의 기록된 Paper 자산 추이. 정확한 값은 아래 표에서 확인할 수 있습니다."
    />
  );
}
