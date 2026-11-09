/* global window, document */
// Apply before the app and its styles paint. Store appearance only, never account/session data.
(() => {
  let preference = 'system';
  try {
    const saved = window.localStorage.getItem('hth-theme');
    if (saved === 'light' || saved === 'dark') preference = saved;
  } catch {
    // Disabled storage falls back to the OS preference.
  }
  const dark = window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;
  const theme = preference === 'system' ? (dark ? 'dark' : 'light') : preference;
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
})();
