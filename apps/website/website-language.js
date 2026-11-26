/* First-party language preference for the public website. */
(function () {
  'use strict';
  const languages = {
    en: ['English', 'Language', 'Automatic', 'Open menu', 'Close menu'],
    ja: ['日本語', '言語', '自動', 'メニューを開く', 'メニューを閉じる'],
    es: ['Español', 'Idioma', 'Automático', 'Abrir el menú', 'Cerrar el menú'],
    ko: ['한국어', '언어', '자동', '메뉴 열기', '메뉴 닫기'],
    'zh-Hans': ['简体中文', '语言', '自动', '打开菜单', '关闭菜单'],
    'zh-Hant': ['繁體中文', '語言', '自動', '開啟選單', '關閉選單'],
    ru: ['Русский', 'Язык', 'Автоматически', 'Открыть меню', 'Закрыть меню'],
    fr: ['Français', 'Langue', 'Automatique', 'Ouvrir le menu', 'Fermer le menu'],
    it: ['Italiano', 'Lingua', 'Automatica', 'Apri il menu', 'Chiudi il menu'],
    de: ['Deutsch', 'Sprache', 'Automatisch', 'Menü öffnen', 'Menü schließen'],
  };
  const key = 'nekko-website-language';
  const supported = (value) => typeof value === 'string' && Object.hasOwn(languages, value);
  const manualChoices = new Set(['auto', ...Object.keys(languages)]);
  const localizedPath = /^\/l\/([^/]+)(?=\/|$)/;
  const plainPath = (path) => path.replace(localizedPath, '') || '/';
  const routeFor = (path, locale) => {
    const pathname = path.split(/[?#]/, 1)[0];
    const plain = plainPath(pathname);
    return (locale === 'en' ? plain : `/l/${locale}${plain === '/' ? '' : plain}`) + path.slice(pathname.length);
  };

  function browserPreference(tags) {
    for (const tag of tags) {
      try {
        const loc = new Intl.Locale(tag);
        if (loc.language === 'zh') {
          if (loc.script === 'Hant' || (!loc.script && ['TW', 'HK', 'MO'].includes(loc.region))) return 'zh-Hant';
          return 'zh-Hans';
        }
        if (supported(loc.language)) return loc.language;
      } catch { /* Ignore malformed language tags. */ }
    }
    return null;
  }

  async function automatic(tags, country) {
    const browser = browserPreference(tags);
    if (browser) return browser;
    try {
      const result = await country();
      if (supported(result)) return result;
    } catch { /* The host may not supply a country hint. */ }
    return 'en';
  }

  function format(catalog, source, values = {}) {
    const message = Object.hasOwn(catalog, source) ? catalog[source] : source;
    return message.replace(/\{([a-z][\w]*)\}/gi, (whole, name) => Object.hasOwn(values, name) ? String(values[name]) : whole);
  }

  if (typeof module !== 'undefined') {
    module.exports = { automatic, browserPreference, format, routeFor, supported };
    return;
  }

  const doc = document;
  const documentLanguage = doc.documentElement.lang;
  const locale = supported(documentLanguage) ? documentLanguage : 'en';
  const explicit = localizedPath.test(location.pathname);
  const root = plainPath(location.pathname) === '/';
  const t = (source, values) => format(window.NekkoWebsiteMessages || {}, source, values);
  window.NekkoSiteLanguage = { locale, t, path: (url) => routeFor(url, locale) };
  let saved;
  try { saved = localStorage.getItem(key); } catch { /* Optional storage. */ }
  let request = 0;

  const prefs = () => navigator.languages?.length ? navigator.languages : [navigator.language];
  async function country() {
    const result = await fetch('/api/site-country', { cache: 'no-store', credentials: 'omit', signal: AbortSignal.timeout(1200) });
    return result.ok ? (await result.json()).locale : null;
  }
  function navigate(language, replace, noStorage = false) {
    if (language === locale) return;
    const search = new URLSearchParams(location.search);
    // If storage is blocked, prevent a fresh English navigation from being
    // immediately redirected back to the browser's automatic language.
    if (noStorage && language === 'en') search.set('site-language', 'en');
    else search.delete('site-language');
    const override = search.toString();
    const query = override === new URLSearchParams(location.search).toString()
      ? location.search : override ? `?${override}` : '';
    const url = routeFor(location.pathname, language) + query + location.hash;
    if (replace) location.replace(url);
    else location.assign(url);
  }
  function choose(value, initial = false) {
    const active = ++request;
    let noStorage = false;
    if (!initial) {
      saved = value;
      try { localStorage.setItem(key, value); } catch { noStorage = true; }
    }
    if (supported(value)) { navigate(value, initial, noStorage); return; }
    const browser = browserPreference(prefs());
    if (browser) { navigate(browser, initial, noStorage); return; }
    automatic([], country).then((next) => { if (active === request) navigate(next, initial, noStorage); });
  }
  if (!explicit && new URLSearchParams(location.search).get('site-language') !== 'en') choose(saved, true);

  function init() {
    const [name, language, auto, openMenu, closeMenu] = languages[locale];
    const header = doc.querySelector('header.nav, header.topbar, header.bar');
    function picker() {
      const field = doc.createElement('label');
      field.className = 'website-language-field';
      const label = doc.createElement('span');
      label.textContent = language;
      const select = doc.createElement('select');
      select.dataset.websiteLanguage = '';
      select.append(new Option(auto, 'auto'));
      for (const [tag, [autonym]] of Object.entries(languages)) {
        const option = new Option(autonym, tag);
        option.lang = tag;
        select.append(option);
      }
      select.value = explicit ? locale : manualChoices.has(saved) ? saved : 'auto';
      select.addEventListener('change', () => choose(select.value));
      field.append(label, select);
      return field;
    }
    const homeMenu = root && header?.querySelector('.nav-links');
    const docsMenu = header?.classList.contains('topbar') && doc.querySelector('#sidebar');
    if (homeMenu || docsMenu) {
      const field = picker();
      field.classList.add('website-language-mobile');
      (homeMenu || docsMenu).prepend(field);
    }

    const menu = doc.createElement('details');
    menu.className = `website-language-menu${homeMenu ? ' website-language-home' : ''}${docsMenu ? ' website-language-docs' : ''}${header ? '' : ' website-language-fixed'}`;
    const toggle = doc.createElement('summary');
    toggle.setAttribute('aria-label', openMenu);
    toggle.title = `${language}: ${name}`;
    toggle.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
    const field = picker();
    menu.append(toggle, field);
    (header || doc.body).append(menu);
    menu.addEventListener('toggle', () => toggle.setAttribute('aria-label', menu.open ? closeMenu : openMenu));
    doc.addEventListener('click', (event) => { if (!menu.contains(event.target)) menu.open = false; });
    doc.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && menu.open) { menu.open = false; toggle.focus(); }
    });
  }
  doc.addEventListener('DOMContentLoaded', init, { once: true });
}());
