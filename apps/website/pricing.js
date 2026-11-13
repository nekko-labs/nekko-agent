/*
 * The pricing page (#2724). Plans show only when Nekko Cloud says billing is
 * on for everyone (GET /v1/billing/plans answers 404 until then), so the page
 * stays "not on sale yet" while a team account has it off or team-only.
 * Prices come from Stripe through the API, never from this file.
 */
(function () {
  'use strict';

  var API = 'https://nekko-agent-api.fly.dev';

  /** "$12 a month" from Stripe's amount in the currency's smallest unit (cents, whole yen). */
  function price(p) {
    var currency = String(p.currency).toUpperCase();
    var digits = new Intl.NumberFormat('en', { style: 'currency', currency: currency }).resolvedOptions().maximumFractionDigits;
    var value = p.amount / Math.pow(10, digits);
    var f = new Intl.NumberFormat(undefined, { style: 'currency', currency: currency, minimumFractionDigits: value % 1 ? digits : 0 });
    return f.format(value) + ' a ' + p.interval;
  }

  /** The Pro plan from the API's answer, or null when nothing is on sale. */
  function pro(body) {
    var plans = body && Array.isArray(body.plans) ? body.plans : [];
    for (var i = 0; i < plans.length; i++) if (plans[i].id === 'pro' && typeof plans[i].amount === 'number') return plans[i];
    return null;
  }

  function load(doc, fetchImpl) {
    return fetchImpl(API + '/v1/billing/plans')
      .then(function (r) { return r.ok ? r.json() : null; })
      .catch(function () { return null; })
      .then(function (body) {
        var p = pro(body);
        if (!p) return false;
        doc.querySelector('[data-pro-price]').textContent = price(p);
        doc.querySelector('[data-plans]').hidden = false;
        doc.querySelector('[data-not-yet]').hidden = true;
        return true;
      });
  }

  window.NekkoPricing = { price: price, pro: pro, load: load };
  if (typeof document !== 'undefined' && document.querySelector('[data-plans]')) load(document, window.fetch.bind(window));
})();
