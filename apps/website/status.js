/*
 * The status page. status.json is written by hand: each service's state and
 * note, past incidents and the known issues list. On top of that, the page
 * asks each service's health check from the visitor's browser, so a service
 * that has stopped answering shows even before anyone edits the file.
 *
 * A state set by hand that isn't "ok" always wins: we know more than a ping.
 */
(function () {
  'use strict';

  var LABELS = {
    ok: 'Working',
    degraded: 'Partly working',
    down: 'Not working',
    unreachable: 'Not answering',
    checking: 'Checking…',
  };
  var CHECK_TIMEOUT_MS = 8000;
  var RECHECK_MS = 60000;

  /** A service's shown state from its hand-set state and its live check ("ok", "fail" or "pending"). */
  function combine(manual, live) {
    if (manual === 'degraded' || manual === 'down') return manual;
    if (live === 'fail') return 'unreachable';
    if (live === 'pending') return 'checking';
    return 'ok';
  }

  /** The banner for a list of shown states. */
  function overall(states) {
    if (states.indexOf('checking') !== -1) return { state: 'checking', text: 'Checking our services…' };
    if (states.indexOf('down') !== -1 || states.indexOf('unreachable') !== -1) return { state: 'down', text: 'Something isn’t working right now' };
    if (states.indexOf('degraded') !== -1) return { state: 'degraded', text: 'Some things are only partly working' };
    return { state: 'ok', text: 'Everything is working' };
  }

  function check(url, fetchImpl) {
    var ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctrl) ctrl.abort(); }, CHECK_TIMEOUT_MS);
    return fetchImpl(url, { cache: 'no-store', signal: ctrl ? ctrl.signal : undefined })
      .then(function (res) { return res.ok ? res.json() : null; })
      .then(function (body) { return body && body.ok === true ? 'ok' : 'fail'; })
      .catch(function () { return 'fail'; })
      .then(function (r) { clearTimeout(timer); return r; });
  }

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function dateText(iso) {
    var d = new Date(iso + 'T00:00:00Z');
    if (isNaN(d)) return iso;
    return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
  }

  function start(root) {
    var data = null;
    var live = {};
    var checkedAt = null;

    function render() {
      var services = data.services || [];
      var shown = services.map(function (s) { return combine(s.state, s.check ? live[s.id] || 'pending' : 'ok'); });
      var top = overall(shown);
      var banner = root.querySelector('.status-banner');
      banner.dataset.state = top.state;
      banner.querySelector('.status-banner-text').textContent = top.text;
      var when = root.querySelector('.status-checked');
      when.textContent = checkedAt ? 'Checked at ' + checkedAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) + ' · updated by hand on ' + dateText(data.updated) : '';

      var list = root.querySelector('.status-services');
      list.textContent = '';
      services.forEach(function (s, i) {
        var li = el('li', 'status-service');
        li.dataset.state = shown[i];
        li.dataset.service = s.id;
        var head = el('div', 'status-service-head');
        head.appendChild(el('strong', null, s.name));
        var pill = el('span', 'status-pill', LABELS[shown[i]]);
        head.appendChild(pill);
        li.appendChild(head);
        if (s.what) li.appendChild(el('p', 'status-what', s.what));
        var note = s.note;
        if (!note && shown[i] === 'unreachable') note = 'It didn’t answer from your browser just now. If your own connection is fine, it’s likely on our side.';
        if (note) li.appendChild(el('p', 'status-note', note));
        list.appendChild(li);
      });

      var inc = root.querySelector('.status-incidents');
      inc.textContent = '';
      var incidents = data.incidents || [];
      if (!incidents.length) inc.appendChild(el('p', 'status-empty', 'No incidents recently.'));
      incidents.forEach(function (x) {
        var art = el('article', 'status-incident');
        art.appendChild(el('h3', null, x.title));
        art.appendChild(el('p', 'micro', dateText(x.date) + (x.resolved ? ' · Resolved' : ' · Ongoing')));
        if (x.text) art.appendChild(el('p', null, x.text));
        inc.appendChild(art);
      });

      var ki = root.querySelector('.status-known');
      ki.textContent = '';
      var issues = data.knownIssues || [];
      if (!issues.length) ki.appendChild(el('p', 'status-empty', 'No known issues right now.'));
      issues.forEach(function (x) {
        var art = el('article', 'status-issue');
        art.appendChild(el('h3', null, x.title));
        var meta = [];
        if (x.where) meta.push(x.where);
        if (x.since) meta.push('Since ' + dateText(x.since));
        if (meta.length) art.appendChild(el('p', 'micro', meta.join(' · ')));
        if (x.detail) art.appendChild(el('p', null, x.detail));
        if (x.workaround) {
          var w = el('p', 'status-workaround');
          w.appendChild(el('strong', null, 'Workaround: '));
          w.appendChild(document.createTextNode(x.workaround));
          art.appendChild(w);
        }
        ki.appendChild(art);
      });
    }

    function runChecks() {
      var services = (data.services || []).filter(function (s) { return s.check; });
      services.forEach(function (s) { live[s.id] = 'pending'; });
      render();
      return Promise.all(services.map(function (s) {
        return check(s.check, window.fetch.bind(window)).then(function (r) { live[s.id] = r; });
      })).then(function () { checkedAt = new Date(); render(); });
    }

    fetch('status.json', { cache: 'no-store' })
      .then(function (res) { return res.json(); })
      .then(function (json) {
        data = json;
        runChecks();
        var again = root.querySelector('.status-recheck');
        again.hidden = false;
        again.addEventListener('click', runChecks);
        setInterval(function () { if (!document.hidden) runChecks(); }, RECHECK_MS);
      })
      .catch(function () {
        var banner = root.querySelector('.status-banner');
        banner.dataset.state = 'down';
        banner.querySelector('.status-banner-text').textContent = 'The status list didn’t load. Try reloading the page.';
      });
  }

  var api = { combine: combine, overall: overall, check: check };
  if (typeof window !== 'undefined') window.NekkoStatus = api;
  if (typeof document !== 'undefined') {
    var root = document.getElementById('status-root');
    if (root) start(root);
  }
})();
