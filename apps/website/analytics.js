// PostHog for nekkoagent.com, cookieless: nothing is stored in the browser
// (persistence: memory), so there is no consent banner to show. Pageviews,
// clicks and the referrer only; no session recordings, no person profiles.
// Stays off until POSTHOG_KEY holds the Nekko Agent project's public phc_ key.
(function () {
  var POSTHOG_KEY = '';
  if (!POSTHOG_KEY || location.hostname !== 'nekkoagent.com') return;
  // PostHog's loader snippet: queues calls until array.js arrives.
  !function(t,e){var o,n,p,r;e.__SV||(window.posthog=e,e._i=[],e.init=function(i,s,a){function g(t,e){var o=e.split(".");2==o.length&&(t=t[o[0]],e=o[1]),t[e]=function(){t.push([e].concat(Array.prototype.slice.call(arguments,0)))}}(p=t.createElement("script")).type="text/javascript",p.crossOrigin="anonymous",p.async=!0,p.src=s.api_host.replace(".i.posthog.com","-assets.i.posthog.com")+"/static/array.js",(r=t.getElementsByTagName("script")[0]).parentNode.insertBefore(p,r);var u=e;for(void 0!==a?u=e[a]=[]:a="posthog",u.people=u.people||[],u.toString=function(t){var e="posthog";return"posthog"!==a&&(e+="."+a),t||(e+=" (stub)"),e},u.people.toString=function(){return u.toString(1)+".people (stub)"},o="init capture register register_once unregister opt_out_capturing has_opted_out_capturing opt_in_capturing reset identify alias set_config".split(" "),n=0;n<o.length;n++)g(u,o[n]);e._i.push([i,s,a])},e.__SV=1)}(document,window.posthog||[]);
  window.posthog.init(POSTHOG_KEY, {
    api_host: 'https://us.i.posthog.com',
    persistence: 'memory',
    person_profiles: 'identified_only',
    capture_pageview: 'history_change',
    disable_session_recording: true,
  });
  window.posthog.register({ site: 'nekkoagent.com' });
})();
