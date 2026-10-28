export function formatDecimal(value: string | undefined, digits = 2, signed = false) {
  if (value === undefined) return '—';
  const negative = value.startsWith('-');
  const [whole = '0', fraction = ''] = value.replace(/^-/, '').split('.');
  const scale = 10n ** BigInt(digits);
  const extended = fraction.padEnd(digits + 1, '0');
  let units = BigInt(whole) * scale + BigInt(extended.slice(0, digits) || '0');
  if ((extended[digits] ?? '0') >= '5') units += 1n;
  const prefix = units === 0n ? '' : negative ? '−' : signed ? '+' : '';
  return `${prefix}${new Intl.NumberFormat('ko-KR').format(units / scale)}${digits ? `.${(units % scale).toString().padStart(digits, '0')}` : ''}`;
}

export function formatMoney(value: string | undefined, currency: 'KRW' | 'USD') {
  return value === undefined
    ? '—'
    : `${currency === 'KRW' ? '₩' : '$'}${formatDecimal(value, currency === 'KRW' ? 0 : 2)}`;
}

export function formatTime(value: string | null | undefined) {
  return value
    ? new Intl.DateTimeFormat('ko-KR', {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hourCycle: 'h23',
      }).format(new Date(value))
    : '시각 미제공';
}

export function profitClass(value: string) {
  return !/[1-9]/.test(value) ? 'text-slate-400' : value.startsWith('-') ? 'text-sky-400' : 'text-rose-400';
}
