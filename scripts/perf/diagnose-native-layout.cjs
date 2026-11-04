// Diagnostic only: native-call durations during measured chat switches.
const fs = require('node:fs');
require('./diagnose-switch-marks.cjs');
const p = 'scripts/perf/lib/probes.mjs';
let s = fs.readFileSync(p, 'utf8');
const anchor = '  P.armSwitch = (title, marker, timeoutMs = 15000) => {';
if (!s.includes(anchor)) throw Error('Missing armSwitch anchor');
const wrappers = `
  P.nativeCalls = [];
  const wrapNative = (proto, key) => {
    const original = proto[key];
    if (typeof original !== 'function') return;
    proto[key] = function (...args) {
      if (!P.activeSwitch) return Reflect.apply(original, this, args);
      const at = performance.now();
      try { return Reflect.apply(original, this, args); }
      finally {
        const duration = performance.now() - at;
        if (duration >= 0.2) P.nativeCalls.push({
          switchId: P.activeSwitch, name: key, at, duration,
          tag: this?.tagName, className: typeof this?.className === 'string' ? this.className : '',
          stack: duration >= 1 ? new Error().stack : undefined,
        });
      }
    };
  };
  wrapNative(SVGSVGElement.prototype, 'setCurrentTime');
  wrapNative(SVGSVGElement.prototype, 'pauseAnimations');
  wrapNative(HTMLElement.prototype, 'focus');
  wrapNative(Element.prototype, 'getBoundingClientRect');
  wrapNative(Element.prototype, 'checkVisibility');
`;
s = s.replace(anchor, wrappers + anchor)
  .replace('mark("finish");', 'mark("finish"); P.activeSwitch = null;')
  .replace('start = e.timeStamp; mark("click");', 'start = e.timeStamp; P.activeSwitch = switchId; mark("click");');
fs.writeFileSync(p, s);
const r = 'scripts/perf/run.mjs';
s = fs.readFileSync(r, 'utf8').replace('switches: window.__perf.switchDiagnostics, marks:', 'switches: window.__perf.switchDiagnostics, nativeCalls: window.__perf.nativeCalls, marks:');
fs.writeFileSync(r, s);
const timeline = 'scripts/perf/lib/profile.mjs';
s = fs.readFileSync(timeline, 'utf8').replace("e.ph === 'M' || keep.has(e.name)", "e.ph === 'M' || e.name.startsWith('cold-diag-') || keep.has(e.name)");
fs.writeFileSync(timeline, s);
