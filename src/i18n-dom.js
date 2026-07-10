// Shared i18n DOM helper for the Electron control panel and the browser
// viewer. Plain script (no modules — both UIs are unbundled IIFEs); expects
// the vendored i18next UMD global to be loaded first.
(function () {
  const ATTR_MAP = [
    ['data-i18n-placeholder', 'placeholder'],
    ['data-i18n-aria-label', 'aria-label'],
    ['data-i18n-title', 'title'],
    ['data-i18n-alt', 'alt'],
  ];

  // Translates every element carrying a data-i18n* attribute. Only static
  // strings are annotated — elements whose text is driven by JS state are
  // re-rendered by their owners via i18next.t().
  window.applyI18n = function (root) {
    const scope = root || document;
    scope.querySelectorAll('[data-i18n]').forEach((el) => {
      el.textContent = i18next.t(el.getAttribute('data-i18n'));
    });
    for (const [dataAttr, targetAttr] of ATTR_MAP) {
      scope.querySelectorAll('[' + dataAttr + ']').forEach((el) => {
        el.setAttribute(targetAttr, i18next.t(el.getAttribute(dataAttr)));
      });
    }
    document.documentElement.lang = i18next.language;
  };

  // Saved choice wins; otherwise a uk-prefixed system/browser locale picks
  // Ukrainian; everything else falls back to English.
  window.pickLanguage = function (systemLocale) {
    try {
      const saved = localStorage.getItem('screencast:lang');
      if (saved === 'en' || saved === 'uk') return saved;
    } catch {}
    return String(systemLocale || '').toLowerCase().startsWith('uk') ? 'uk' : 'en';
  };
})();
