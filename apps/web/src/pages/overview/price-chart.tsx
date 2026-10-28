import { useEffect, useRef } from 'react';
import { CandlestickSeries, ColorType, createChart } from 'lightweight-charts';
import type { UTCTimestamp } from 'lightweight-charts';
import type { DashboardSnapshot } from '@shared/api/dashboard';

export function PriceChart({ instrument }: { instrument: DashboardSnapshot['watchlist'][number] }) {
  const container = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!container.current || instrument.candles.length === 0) return;
    const chart = createChart(container.current, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: '#111a2b' }, textColor: '#8392aa', attributionLogo: true },
      grid: { vertLines: { color: '#1b2639' }, horzLines: { color: '#1b2639' } },
      rightPriceScale: { borderColor: '#263247' },
      timeScale: { borderColor: '#263247', timeVisible: instrument.interval === '1m', secondsVisible: false },
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
      upColor: '#fb7185',
      downColor: '#38bdf8',
      borderVisible: false,
      wickUpColor: '#fb7185',
      wickDownColor: '#38bdf8',
      priceFormat: {
        type: 'price',
        precision: instrument.currency === 'KRW' ? 0 : 2,
        minMove: instrument.currency === 'KRW' ? 1 : 0.01,
      },
    });
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
    return () => chart.remove();
  }, [instrument]);
  return (
    <div ref={container} className="h-80 w-full" aria-label={`${instrument.name} 캔들 차트`}>
      {instrument.candles.length === 0 && (
        <p className="p-10 text-center text-sm text-slate-400">조회된 캔들이 없습니다.</p>
      )}
    </div>
  );
}
