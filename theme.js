// Light/dark theme toggle shared by every page. Follows the system theme until the user picks one.
(() => {
  'use strict';

  const THEME_KEY = 'claudethinks.theme';

  function applyTheme(theme) {
    if (theme) document.documentElement.dataset.theme = theme;
    else delete document.documentElement.dataset.theme;
  }

  try { applyTheme(localStorage.getItem(THEME_KEY)); } catch { /* storage unavailable */ }

  const button = document.getElementById('btn-theme');
  if (!button) return;
  button.addEventListener('click', () => {
    const current = document.documentElement.dataset.theme
      || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    const next = current === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    try { localStorage.setItem(THEME_KEY, next); } catch { /* storage unavailable */ }
  });
})();
