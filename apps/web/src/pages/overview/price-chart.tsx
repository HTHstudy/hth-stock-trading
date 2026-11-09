import { useEffect, useRef } from 'react';
import { CandlestickSeries, ColorType, createChart } from 'lightweight-charts';
import type { IChartApi, ISeriesApi, UTCTimestamp } from 'lightweight-charts';
import { getChartTheme } from '@shared/lib/chart-theme';
import { useTheme } from '@shared/lib/theme';
import type { DashboardSnapshot } from '@shared/api/dashboard';

export function PriceChart({ instrument }: { instrument: DashboardSnapshot['watchlist'][number] }) {
  const container = useRef<HTMLDivElement>(null);
  const { theme } = useTheme();
  const chartInstance = useRef<{ chart: IChartApi; series: ISeriesApi<'Candlestick'>[] } | null>(null);
  useEffect(() => {
    if (!container.current || instrument.candles.length === 0) return;
    const chart = createChart(container.current, {
      autoSize: true,
      layout: { attributionLogo: true },
      timeScale: { timeVisible: instrument.interval === '1m', secondsVisible: false },
      localization: {
        locale: 'ko-KR',
        timeFormatter: (time: number) =>
          new Intl.DateTimeFormat('ko-KR', {
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            hourCycle: 'h23',
          }).format(new Date(time * 1000)),
      },
    });
    const series = chart.addSeries(CandlestickSeries, {
      borderVisible: false,
      priceFormat: {
        type: 'price',
        precision: instrument.currency === 'KRW' ? 0 : 2,
        minMove: instrument.currency === 'KRW' ? 1 : 0.01,
      },
    });
    chartInstance.current = { chart, series: [series] };
    series.setData(
      instrument.candles.map((candle) => ({
        time: Math.floor(Date.parse(candle.timestamp) / 1000) as UTCTimestamp,
        open: Number(candle.open),
        high: Number(candle.high),
        low: Number(candle.low),
        close: Number(candle.close),
      })),
    );
    chart.timeScale().fitContent();
    return () => {
      chartInstance.current = null;
      chart.remove();
    };
  }, [instrument]);

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
    instance.series.forEach((series) =>
      series.applyOptions({
        upColor: palette.up,
        downColor: palette.down,
        wickUpColor: palette.up,
        wickDownColor: palette.down,
      }),
    );
  }, [theme, instrument]);
  return (
    <div ref={container} className="h-80 w-full" aria-label={`${instrument.name} 캔들 차트`}>
      {instrument.candles.length === 0 && (
        <p className="p-10 text-center text-sm text-muted">조회된 캔들이 없습니다.</p>
      )}
    </div>
  );
}
