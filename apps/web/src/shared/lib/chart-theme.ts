const chartThemes = {
  light: {
    background: '#ffffff',
    text: '#475569',
    border: '#cbd5e1',
    grid: '#e2e8f0',
    line: '#0f766e',
    comparisonLine: '#7c3aed',
    up: '#dc2626',
    down: '#2563eb',
  },
  dark: {
    background: '#111a2b',
    text: '#94a3b8',
    border: '#263247',
    grid: '#1b2639',
    line: '#5eead4',
    comparisonLine: '#a78bfa',
    up: '#fb7185',
    down: '#60a5fa',
  },
} as const;

export function getChartTheme(theme: 'light' | 'dark') {
  return chartThemes[theme];
}
