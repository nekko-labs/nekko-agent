// Consent-first analytics for nekkoagent.com. The PostHog SDK is not requested
// until a visitor explicitly accepts. Rejecting, withdrawing, Global Privacy
// Control and Do Not Track all keep capture off. Session recording stays disabled.
(function () {
  'use strict';

  var CONSENT_KEY = 'nekko-website-analytics-consent-v1';
  var STYLE_ID = 'nekko-privacy-controls-style';
  var PRODUCTION_HOST = 'nekkoagent.com';
  var memoryChoice = null;
  var root = null;
  var panel = null;
  var manageButton = null;
  var sdkStarted = false;
  var sdkConsentActive = false;
  var posthogClient = null;

  function storageGet(key) {
    try { return window.localStorage.getItem(key); } catch (_) { return null; }
  }

  function storageSet(key, value) {
    try { window.localStorage.setItem(key, value); return true; } catch (_) { return false; }
  }

  function storedChoice() {
    var choice = memoryChoice || storageGet(CONSENT_KEY);
    return choice === 'accepted' || choice === 'rejected' ? choice : 'undecided';
  }

  function privacySignal() {
    if (window.navigator && window.navigator.globalPrivacyControl === true) return 'Global Privacy Control';
    var dnt = window.navigator && (window.navigator.doNotTrack || window.doNotTrack);
    return dnt === '1' || dnt === 'yes' ? 'Do Not Track' : '';
  }

  function effectiveChoice() {
    return privacySignal() ? 'signal' : storedChoice();
  }

  function analyticsConfig() {
    var config = window.NekkoAnalyticsConfig;
    if (!config || typeof config.projectToken !== 'string' || !config.projectToken) return null;
    if (typeof config.apiHost !== 'string' || !/^https:\/\//.test(config.apiHost)) return null;
    return config;
  }

  function cleanUrl(value) {
    if (typeof value !== 'string' || !value) return value;
    try {
      var url = new URL(value, window.location.origin);
      return url.origin + url.pathname;
    } catch (_) {
      return value.split(/[?#]/)[0];
    }
  }

  function minimizeEvent(event) {
    if (!event || effectiveChoice() !== 'accepted') return false;
    var props = event.properties || (event.properties = {});
    var urlKeys = ['$current_url', '$initial_current_url', '$session_entry_url', '$referrer', '$initial_referrer'];
    for (var i = 0; i < urlKeys.length; i += 1) {
      if (props[urlKeys[i]]) props[urlKeys[i]] = cleanUrl(props[urlKeys[i]]);
    }
    for (var key in props) {
      if (/^\$web_vitals_[A-Z0-9]+_event$/.test(key) && props[key] && typeof props[key].url === 'string') {
        props[key].url = cleanUrl(props[key].url);
      }
    }
    props.$geoip_disable = true;
    props.analytics_consent = 'accepted';
    props.analytics_schema_version = 2;
    return event;
  }

  function installPostHogStub() {
    if (window.posthog && window.posthog.__SV) return;
    !function(t,e){var o,n,p,r;e.__SV||(window.posthog=e,e._i=[],e.init=function(i,s,a){function g(t,e){var o=e.split('.');2==o.length&&(t=t[o[0]],e=o[1]),t[e]=function(){t.push([e].concat(Array.prototype.slice.call(arguments,0)))}}(p=t.createElement('script')).type='text/javascript',p.crossOrigin='anonymous',p.async=!0,p.src=s.api_host.replace('.i.posthog.com','-assets.i.posthog.com')+'/static/array.js',(r=t.getElementsByTagName('script')[0]).parentNode.insertBefore(p,r);var u=e;for(void 0!==a?u=e[a]=[]:a='posthog',u.people=u.people||[],u.toString=function(t){var e='posthog';return'posthog'!==a&&(e+='.'+a),t||(e+=' (stub)'),e},u.people.toString=function(){return u.toString(1)+'.people (stub)'},o='init capture register register_once unregister opt_out_capturing has_opted_out_capturing opt_in_capturing reset identify alias set_config'.split(' '),n=0;n<o.length;n++)g(u,o[n]);e._i.push([i,s,a])},e.__SV=1)}(document,window.posthog||[]);
  }

  function activatePostHog(posthog) {
    if (!posthog || effectiveChoice() !== 'accepted') {
      if (posthog && typeof posthog.opt_out_capturing === 'function') posthog.opt_out_capturing();
      sdkConsentActive = false;
      return false;
    }
    if (sdkConsentActive) return true;
    posthog.opt_in_capturing();
    posthog.register({ site: 'nekkoagent.com' });
    sdkConsentActive = true;
    posthog.capture('$pageview');
    return true;
  }

  function loadPostHog() {
    if (effectiveChoice() !== 'accepted' || window.location.hostname !== PRODUCTION_HOST) return false;
    if (sdkStarted) {
      if (posthogClient) activatePostHog(posthogClient);
      return true;
    }
    var config = analyticsConfig();
    if (!config) return false;
    sdkStarted = true;
    installPostHogStub();
    window.posthog.init(config.projectToken, {
      api_host: config.apiHost,
      defaults: '2026-08-30',
      opt_out_capturing_by_default: true,
      opt_out_capturing_persistence_type: 'localStorage',
      consent_persistence_name: 'nekko-posthog-consent',
      persistence: 'localStorage+cookie',
      person_profiles: 'never',
      capture_pageview: false,
      capture_pageleave: false,
      autocapture: false,
      rageclick: false,
      capture_dead_clicks: false,
      capture_heatmaps: false,
      capture_exceptions: false,
      disable_surveys: true,
      disable_session_recording: true,
      advanced_disable_flags: true,
      mask_personal_data_properties: true,
      disable_capture_url_hashes: true,
      capture_performance: {
        network_timing: false,
        web_vitals: true,
        web_vitals_allowed_metrics: ['CLS', 'FCP', 'INP', 'LCP'],
      },
      before_send: minimizeEvent,
      loaded: function (posthog) {
        posthogClient = posthog;
        activatePostHog(posthog);
      },
    });
    return true;
  }

  function forgetPostHogStorage() {
    var config = analyticsConfig();
    var token = config && config.projectToken;
    try {
      for (var i = window.localStorage.length - 1; i >= 0; i -= 1) {
        var key = window.localStorage.key(i);
        if (key && (key.indexOf('ph_') === 0 || key.indexOf('__ph') === 0 || (token && key.indexOf(token) !== -1))) {
          window.localStorage.removeItem(key);
        }
      }
    } catch (_) {}
    try {
      document.cookie.split(';').forEach(function (part) {
        var name = part.split('=')[0].trim();
        if (!name || !(name.indexOf('ph_') === 0 || name.indexOf('__ph') === 0 || (token && name.indexOf(token) !== -1))) return;
        document.cookie = name + '=; Max-Age=0; path=/; SameSite=Lax';
        document.cookie = name + '=; Max-Age=0; path=/; domain=.nekkoagent.com; SameSite=Lax';
      });
    } catch (_) {}
  }

  function stopPostHog() {
    sdkConsentActive = false;
    var posthog = posthogClient || window.posthog;
    if (posthog) {
      try { if (typeof posthog.reset === 'function') posthog.reset(true); } catch (_) {}
      try { if (typeof posthog.opt_out_capturing === 'function') posthog.opt_out_capturing(); } catch (_) {}
    }
    forgetPostHogStorage();
  }

  function setChoice(choice) {
    if (choice !== 'accepted' && choice !== 'rejected') return;
    memoryChoice = choice;
    storageSet(CONSENT_KEY, choice);
    if (choice === 'accepted' && !privacySignal()) loadPostHog();
    else stopPostHog();
    render(false);
  }

  function syncStoredChoice(event) {
    if (!event || (event.key !== CONSENT_KEY && event.key !== null)) return;
    memoryChoice = event.newValue === 'accepted' || event.newValue === 'rejected' ? event.newValue : null;
    if (effectiveChoice() === 'accepted') loadPostHog();
    else stopPostHog();
    render(false);
  }

  function capture(name, properties) {
    if (effectiveChoice() !== 'accepted') return false;
    loadPostHog();
    if (!window.posthog || typeof window.posthog.capture !== 'function') return false;
    try { window.posthog.capture(name, properties || {}); return true; } catch (_) { return false; }
  }

  function sectionOf(el) {
    var section = el.closest('section[id]');
    if (section) return section.id;
    if (el.closest('.nav, .topbar')) return 'nav';
    if (el.closest('footer')) return 'footer';
    return '';
  }

  function labelOf(el) {
    var text = (el.getAttribute('aria-label') || el.textContent || '').trim();
    return text.replace(/\s+/g, ' ').slice(0, 80);
  }

  function installClickCapture() {
    document.addEventListener('click', function (event) {
      var target = event.target instanceof Element ? event.target.closest('[data-cta]') : null;
      if (!target) return;
      var href = target.getAttribute('href') || '';
      var properties = {
        cta: target.getAttribute('data-cta') || '',
        section: sectionOf(target),
        label: labelOf(target),
      };
      if (href) properties.href = cleanUrl(href);
      capture('cta_click', properties);
    }, { capture: true });
  }

  function ensureStyles() {
    if (document.getElementById(STYLE_ID)) return;
    var link = document.createElement('link');
    link.id = STYLE_ID;
    link.rel = 'stylesheet';
    link.href = '/privacy-controls.css?v=1';
    document.head.appendChild(link);
  }

  function button(label, action) {
    var el = document.createElement('button');
    el.type = 'button';
    el.className = 'privacy-choice';
    el.textContent = label;
    el.addEventListener('click', action);
    return el;
  }

  function closePanel() {
    if (!panel || !manageButton) return;
    panel.hidden = true;
    manageButton.hidden = false;
    manageButton.focus();
  }

  function openPanel() {
    if (!panel || !manageButton) return;
    manageButton.hidden = true;
    render(true);
    panel.hidden = false;
    var first = panel.querySelector('button');
    if (first) first.focus();
  }

  var t = window.NekkoSiteLanguage?.t || function (text, values) { return text.replace('{signal}', values?.signal || ''); };

  function render(open) {
    if (!root) return;
    var choice = effectiveChoice();
    var title = panel.querySelector('[data-privacy-title]');
    var copy = panel.querySelector('[data-privacy-copy]');
    var note = panel.querySelector('[data-privacy-note]');
    var actions = panel.querySelector('[data-privacy-actions]');
    var close = panel.querySelector('[data-privacy-close]');
    note.hidden = choice === 'undecided';
    actions.textContent = '';
    close.hidden = choice === 'undecided' || choice === 'signal';

    if (choice === 'signal') {
      title.textContent = t('Your privacy signal is on');
      copy.textContent = t('{signal} tells us to keep analytics off. No PostHog script is loaded and no analytics event is sent.', { signal: privacySignal() });
      note.textContent = t('We never sell or share personal information for advertising.');
      actions.appendChild(button(t('Got it'), closePanel));
      manageButton.textContent = t('Privacy choices · analytics off');
    } else if (choice === 'accepted') {
      title.textContent = t('Analytics is on');
      copy.textContent = t('PostHog measures visits, button clicks and Core Web Vitals with a random session identity.');
      note.textContent = t('Session recording is disabled. You can withdraw now.');
      actions.appendChild(button(t('Turn analytics off'), function () { setChoice('rejected'); }));
      actions.appendChild(button(t('Keep analytics on'), closePanel));
      manageButton.textContent = t('Privacy choices · analytics on');
    } else if (choice === 'rejected') {
      title.textContent = t('Analytics is off');
      copy.textContent = t('No PostHog script is loaded and no analytics event is sent. The site works the same either way.');
      note.textContent = t('We remember this choice on this browser. You can change it now.');
      actions.appendChild(button(t('Keep analytics off'), closePanel));
      actions.appendChild(button(t('Allow analytics'), function () { setChoice('accepted'); }));
      manageButton.textContent = t('Privacy choices · analytics off');
    } else {
      title.textContent = t('Help us improve Nekko Agent?');
      copy.textContent = t('We never sell or share this data for advertising.');
      note.textContent = '';
      actions.appendChild(button(t('Reject analytics'), function () { setChoice('rejected'); }));
      actions.appendChild(button(t('Allow analytics'), function () { setChoice('accepted'); }));
      manageButton.textContent = t('Privacy choices');
    }

    panel.hidden = !open && choice !== 'undecided' && choice !== 'signal';
    manageButton.hidden = !panel.hidden;
  }

  function mountControls() {
    ensureStyles();
    root = document.createElement('div');
    root.className = 'privacy-controls ph-no-capture';
    root.innerHTML = '<section class="privacy-panel" role="region" aria-labelledby="nekko-privacy-title">' +
      '<button class="privacy-close" type="button" data-privacy-close aria-label="Close privacy choices">Close</button>' +
      '<p class="privacy-kicker">Your choice</p>' +
      '<h2 id="nekko-privacy-title" data-privacy-title></h2>' +
      '<p data-privacy-copy></p>' +
      '<p class="privacy-note" data-privacy-note></p>' +
      '<div class="privacy-actions" data-privacy-actions></div>' +
      '<a class="privacy-policy-link" href="/privacy#website-analytics">Privacy details</a>' +
      '</section>' +
      '<button class="privacy-manage" type="button" aria-haspopup="true" hidden></button>';
    document.body.appendChild(root);
    var policy = root.querySelector('.privacy-policy-link');
    policy.textContent = t('Privacy details');
    policy.href = window.NekkoSiteLanguage?.path('/privacy#website-analytics') || '/privacy#website-analytics';
    root.querySelector('.privacy-kicker').textContent = t('Your choice');
    var close = root.querySelector('[data-privacy-close]');
    close.textContent = t('Close');
    close.setAttribute('aria-label', t('Close privacy choices'));
    panel = root.querySelector('.privacy-panel');
    manageButton = root.querySelector('.privacy-manage');
    panel.querySelector('[data-privacy-close]').addEventListener('click', closePanel);
    manageButton.addEventListener('click', openPanel);
    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' && panel && !panel.hidden && effectiveChoice() !== 'undecided') closePanel();
    });
    render(false);
  }

  window.NekkoAnalytics = {
    accept: function () { setChoice('accepted'); },
    reject: function () { setChoice('rejected'); },
    capture: capture,
    choice: effectiveChoice,
    open: openPanel,
  };

  window.addEventListener('storage', syncStoredChoice);
  installClickCapture();
  mountControls();
  if (effectiveChoice() === 'accepted') loadPostHog();
  else if (effectiveChoice() === 'signal') forgetPostHogStorage();
})();
