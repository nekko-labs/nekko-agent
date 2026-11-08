// PostHog for nekkoagent.com, cookieless: nothing is stored in the browser
// (persistence: memory), so there is no consent banner to show. Pageviews,
// clicks and the referrer only; no session recordings, no person profiles.
// The project is the Nekko Agent project in the Nekko Labs org; the same
// public write-only key the engine ships. Privacy policy lists PostHog.
(function () {
  var POSTHOG_KEY = 'phc_za3XdjQKQjDxbNgxDvmtfJXTMmtszrNX4q2D7QgcqSd9';
  if (!POSTHOG_KEY || location.hostname !== 'nekkoagent.com') return;
  // PostHog's loader snippet: queues calls until array.js arrives.
  !function(t,e){var o,n,p,r;e.__SV||(window.posthog=e,e._i=[],e.init=function(i,s,a){function g(t,e){var o=e.split(".");2==o.length&&(t=t[o[0]],e=o[1]),t[e]=function(){t.push([e].concat(Array.prototype.slice.call(arguments,0)))}}(p=t.createElement("script")).type="text/javascript",p.crossOrigin="anonymous",p.async=!0,p.src=s.api_host.replace(".i.posthog.com","-assets.i.posthog.com")+"/static/array.js",(r=t.getElementsByTagName("script")[0]).parentNode.insertBefore(p,r);var u=e;for(void 0!==a?u=e[a]=[]:a="posthog",u.people=u.people||[],u.toString=function(t){var e="posthog";return"posthog"!==a&&(e+="."+a),t||(e+=" (stub)"),e},u.people.toString=function(){return u.toString(1)+".people (stub)"},o="init capture register register_once unregister opt_out_capturing has_opted_out_capturing opt_in_capturing reset identify alias set_config".split(" "),n=0;n<o.length;n++)g(u,o[n]);e._i.push([i,s,a])},e.__SV=1)}(document,window.posthog||[]);
  window.posthog.init(POSTHOG_KEY, {
    api_host: 'https://us.i.posthog.com',
    persistence: 'memory',
    person_profiles: 'identified_only',
    capture_pageview: 'history_change',
    disable_session_recording: true,
    autocapture: false,
  });
  window.posthog.register({ site: 'nekkoagent.com' });

  // One delegated handler for every CTA on the page. The CTA's own tag carries
  // a `data-cta` name; the nearest `<section id>` names the section it lives in.
  // The href or form target comes along so Windows vs macOS, releases link vs
  // docs link, GitHub vs mailto are all separable without more wiring.
  function sectionOf(el) {
    var sec = el.closest('section[id]');
    if (sec) return sec.id;
    if (el.closest('.nav')) return 'nav';
    if (el.closest('footer')) return 'footer';
    return '';
  }
  function labelOf(el) {
    var t = (el.getAttribute('aria-label') || el.textContent || '').trim();
    return t.replace(/\s+/g, ' ').slice(0, 80);
  }
  document.addEventListener('click', function (e) {
    var target = e.target instanceof Element ? e.target.closest('[data-cta]') : null;
    if (!target) return;
    var cta = target.getAttribute('data-cta') || '';
    var href = target.getAttribute('href') || '';
    var props = { cta: cta, section: sectionOf(target), label: labelOf(target) };
    if (href) props.href = href;
    try { window.posthog.capture('cta_click', props); } catch (_) {}
  }, { capture: true });
})();
