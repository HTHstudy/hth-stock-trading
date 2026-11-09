import { useTheme } from '@shared/lib/theme';

const choices = [
  { value: 'system', label: '시스템' },
  { value: 'light', label: '라이트' },
  { value: 'dark', label: '다크' },
] as const;

export function ThemeControl() {
  const { preference, setPreference } = useTheme();
  return (
    <div className="flex flex-wrap items-center justify-end gap-3 border-b border-line bg-canvas px-5 py-2">
      <span className="text-xs text-muted">화면 테마</span>
      <div
        role="group"
        aria-label="화면 테마"
        className="inline-flex gap-1 rounded-xl border border-line bg-surface p-1"
      >
        {choices.map(({ value, label }) => (
          <button
            key={value}
            type="button"
            aria-pressed={preference === value}
            onClick={() => setPreference(value)}
            className={`rounded-lg px-3 py-2 text-xs focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${
              preference === value ? 'bg-accent-fill/10 font-semibold text-accent' : 'text-muted hover:bg-hover'
            }`}
          >
            {label}
          </button>
        ))}
      </div>
    </div>
  );
}
