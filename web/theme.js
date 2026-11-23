// Light or dark, set on <html> before the page paints: the one picked here, else the system's.
// window.Q2Theme.pick('light' | 'dark' | null) picks one, null following the system again.
(function () {
  'use strict';
  const KEY = 'eq-studio-theme';
  const root = document.documentElement;
  const dark = matchMedia('(prefers-color-scheme: dark)');
  let picked = null;
  try {
    picked = localStorage.getItem(KEY);
  } catch {
    // Private browsing: the system's, then.
  }

  function apply() {
    const theme = picked === 'light' || picked === 'dark' ? picked : dark.matches ? 'dark' : 'light';
    root.dataset.theme = theme;
    for (const meta of document.querySelectorAll('meta[name=theme-color]')) meta.content = theme === 'dark' ? '#0d0e10' : '#f2f2f7';
  }

  apply();
  dark.addEventListener('change', apply);
  window.Q2Theme = {
    get picked() { return picked; },
    pick(theme) {
      picked = theme;
      try {
        if (theme) localStorage.setItem(KEY, theme);
        else localStorage.removeItem(KEY);
      } catch {
        // Kept for this visit only.
      }
      apply();
    },
  };
})();
