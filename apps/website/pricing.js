/*
 * The pricing page (#2724, #3192). Renders tiers and the comparison table from
 * the shared plan catalog (plan-catalog.json, written by scripts/build-docs.mjs
 * from packages/shared/src/plan-catalog.json at deploy time).
 *
 * The Pro price comes from the billing API at runtime; until billing is on for
 * everyone the API answers 404 and the page shows "Coming soon" for Pro under
 * the "not on sale yet" banner. When billing is on the price fills in and the
 * banner hides.
 */
(function () {
  'use strict';

  var t = window.NekkoSiteLanguage?.t || function (text) { return text; };
  var API = 'https://nekko-agent-api.fly.dev';
  var CATALOG_URL = '/plan-catalog.json';

  var CHECK = '<svg width="13" height="13" viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 6.3l2.3 2.3 4.7-5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /** "$12 a month" from Stripe's amount in the currency's smallest unit (cents, whole yen). */
  function price(p) {
    var currency = String(p.currency).toUpperCase();
    var digits = new Intl.NumberFormat('en', { style: 'currency', currency: currency }).resolvedOptions().maximumFractionDigits;
    var value = p.amount / Math.pow(10, digits);
    var f = new Intl.NumberFormat(undefined, { style: 'currency', currency: currency, minimumFractionDigits: value % 1 ? digits : 0 });
    return f.format(value) + ' a ' + p.interval;
  }

  /** The Pro plan from the billing API's answer, or null when nothing is on sale. */
  function pro(body) {
    var plans = body && Array.isArray(body.plans) ? body.plans : [];
    for (var i = 0; i < plans.length; i++) if (plans[i].id === 'pro' && typeof plans[i].amount === 'number') return plans[i];
    return null;
  }

  /** Render tier cards into [data-pricing-tiers] from the catalog. */
  function renderTiers(doc, catalog, proPrice) {
    var host = doc.querySelector('[data-pricing-tiers]');
    if (!host || !catalog || !Array.isArray(catalog.plans)) return;
    host.innerHTML = catalog.plans.map(function (p) {
      var isHl = p.id === 'pro';
      var priceDisplay, priceSmall;
      if (p.price === 'free') {
        priceDisplay = '$0';
        priceSmall = '';
      } else if (p.price === 'stripe') {
        if (proPrice) {
          var sep = proPrice.lastIndexOf(' a ');
          priceDisplay = sep >= 0 ? proPrice.slice(0, sep) : proPrice;
          priceSmall = sep >= 0 ? 'a ' + proPrice.slice(sep + 3) : '';
        } else {
          priceDisplay = t('Coming soon');
          priceSmall = '';
        }
      } else {
        priceDisplay = t('Talk to us');
        priceSmall = '';
      }
      var ctaText = p.id === 'free' ? t('Download') : p.id === 'pro' ? t('Get Pro in the app') : t('Email us');
      var ctaHref = p.id === 'free' ? (window.NekkoSiteLanguage?.path('/#download') || '/#download') : p.id === 'pro' ? null : 'mailto:hello@nekkoagent.com';
      var cta = ctaHref
        ? '<a href="' + esc(ctaHref) + '" class="pr-cta">' + esc(ctaText) + '</a>'
        : '<button class="pr-cta"' + (proPrice ? '' : ' disabled') + '>' + esc(ctaText) + '</button>';
      var points = (p.points || []).map(function (x) {
        return '<li>' + CHECK + '<span>' + esc(t(x)) + '</span></li>';
      }).join('');
      return '<article class="pr-tier' + (isHl ? ' pr-tier-hl' : '') + '">' +
        '<h2>' + esc(p.name) + '</h2>' +
        '<div class="pr-price"' + (p.id === 'pro' ? ' data-pro-price' : '') + '>' + esc(priceDisplay) + (priceSmall ? ' <small>' + esc(priceSmall) + '</small>' : '') + '</div>' +
        '<div class="pr-tagline">' + esc(t(p.tagline)) + '</div>' +
        '<ul class="pr-points">' + points + '</ul>' +
        cta +
        '</article>';
    }).join('');
  }

  /** Render the comparison table into [data-pricing-table] from the catalog. */
  function renderTable(doc, catalog) {
    var host = doc.querySelector('[data-pricing-table]');
    if (!host || !catalog || !Array.isArray(catalog.groups)) return;
    function cell(v, hlClass) {
      var cls = hlClass || '';
      if (v === true) return '<span class="' + cls + '">' + CHECK + '</span>';
      if (v === false) return '<span class="' + (cls ? cls + ' ' : '') + 'pr-no">–</span>';
      return '<span class="' + (cls ? cls + ' ' : '') + 'pr-val">' + esc(t(String(v))) + '</span>';
    }
    var rows = catalog.groups.map(function (g) {
      var groupRow = '<div class="pr-table-group"><span>' + esc(t(g.name)) + '</span><span></span><span class="pr-col-hl"></span><span></span></div>';
      var dataRows = (g.rows || []).map(function (r) {
        return '<div class="pr-table-row">' +
          '<span>' + esc(t(r.feature)) + (r.soon ? '<span class="pr-soon">' + esc(t('Soon')) + '</span>' : '') + '</span>' +
          cell(r.free) +
          cell(r.pro, 'pr-col-hl') +
          cell(r.team) +
          '</div>';
      }).join('');
      return groupRow + dataRows;
    }).join('');
    host.innerHTML = '<div class="pr-table-head"><span></span><span>Free</span><span class="pr-col-hl">Pro</span><span>Enterprise</span></div>' + rows;
  }

  /** Wire up the Show/Hide toggle for the comparison table. */
  function wireToggle(doc) {
    var btn = doc.querySelector('#pr-toggle');
    var fold = doc.querySelector('#pr-fold');
    if (!btn || !fold) return;
    btn.addEventListener('click', function () {
      var open = fold.classList.toggle('open');
      btn.classList.toggle('open', open);
      btn.setAttribute('aria-expanded', String(open));
      btn.querySelector('span').textContent = open ? t('Hide the full comparison') : t('Show the full comparison');
    });
  }

  /**
   * Fetch the catalog and billing API, render from catalog immediately,
   * then fill in the Pro price and hide the banner if billing is on.
   */
  function load(doc, fetchImpl) {
    return Promise.all([
      fetchImpl(CATALOG_URL)
        .then(function (r) { return r.ok ? r.json() : null; })
        .catch(function () { return null; }),
      fetchImpl(API + '/v1/billing/plans')
        .then(function (r) { return r.ok ? r.json() : null; })
        .catch(function () { return null; }),
    ]).then(function (results) {
      var catalog = results[0];
      var billingBody = results[1];
      var p = pro(billingBody);
      var proPrice = p ? price(p) : null;

      // Render from catalog. The [data-plans] section shows immediately (tiers
      // with "Coming soon" for Pro) even if billing is off.
      if (catalog) {
        renderTiers(doc, catalog, proPrice);
        renderTable(doc, catalog);
      } else if (p) {
        // Catalog not available but billing is on: at least fill the price
        // into the static fallback's [data-pro-price] element.
        var priceEl = doc.querySelector('[data-pro-price]');
        if (priceEl) priceEl.textContent = proPrice;
      }

      // Hide the "not on sale yet" banner once billing is on.
      if (p) {
        var notYetEl = doc.querySelector('[data-not-yet]');
        if (notYetEl) notYetEl.hidden = true;
      }

      return !!p;
    });
  }

  window.NekkoPricing = { price: price, pro: pro, load: load, renderTiers: renderTiers, renderTable: renderTable };
  if (typeof document !== 'undefined' && document.querySelector('[data-pricing-tiers]')) {
    wireToggle(document);
    load(document, window.fetch.bind(window));
  }
})();
