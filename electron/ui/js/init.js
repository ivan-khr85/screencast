// Bootstrap: i18n init, language switching, advanced-settings toggle,
// initial data loads and status subscription.
(function () {
  'use strict';
  const { els, t, state } = window.App;

  const LANG_KEY = 'screencast:lang';

  // --- Advanced settings (gear in the titlebar + ghost button both toggle) ---

  function toggleAdvanced() {
    const show = els.settings.classList.contains('hidden');
    els.settings.classList.toggle('hidden', !show);
    els.advancedToggle.setAttribute('aria-expanded', String(show));
    window.api.setAdvancedOpen(show);
    window.App.settings.syncPreview();
  }

  els.advancedToggle.addEventListener('click', toggleAdvanced);
  els.settingsGear.addEventListener('click', toggleAdvanced);

  // --- Language ---

  // Re-render every JS-driven string in the current language; static
  // markup is covered by applyI18n(). Readiness re-render also refreshes
  // the hero pill; updateUI refreshes the health label, tunnel badge and
  // start/stop button.
  function refreshDynamicText() {
    if (!els.setupInstall.disabled) els.setupInstall.textContent = t('ui.setup.install');
    const placeholderOpt = els.audioApp.options[0];
    if (placeholderOpt && placeholderOpt.value === '') {
      placeholderOpt.textContent = t('ui.settings.selectApp');
    }
    const lastReadiness = window.App.setup.getLastReadiness();
    if (lastReadiness) window.App.setup.renderReadiness(lastReadiness);
    else window.App.stream.renderReadyPill(true);
    if (state.lastStatus) window.App.stream.updateUI(state.lastStatus);
    else els.startBtn.textContent = t('ui.start.start');
  }

  els.langSelect.addEventListener('change', async () => {
    const lng = els.langSelect.value === 'uk' ? 'uk' : 'en';
    try { localStorage.setItem(LANG_KEY, lng); } catch {}
    await i18next.changeLanguage(lng);
    applyI18n();
    refreshDynamicText();
  });

  // --- Init ---

  (async () => {
    try {
      const { locale, resources } = await window.api.getI18n();
      await i18next.init({ lng: pickLanguage(locale), fallbackLng: 'en', resources });
      applyI18n();
      els.langSelect.value = i18next.language;
      els.startBtn.textContent = t('ui.start.start');
      els.setupInstall.textContent = t('ui.setup.install');
    } catch (err) {
      // IPC failure — keep the English markup as-is; t() falls back to keys
      console.error('i18n init failed:', err);
      await i18next.init({ lng: 'en', fallbackLng: 'en', resources: { en: { translation: {} } } });
    }

    window.App.settings.restore();
    if (els.audioMode.value === 'app') {
      els.audioAppField.classList.remove('hidden');
      window.App.settings.loadAudioApps();
    }
    window.App.settings.loadScreenSources();
    window.App.setup.checkReadiness();
    window.api.getStatus().then(window.App.stream.updateUI);
    window.api.onStatusUpdate(window.App.stream.updateUI);
  })();
})();
