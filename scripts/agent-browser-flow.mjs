// The agent-like flow driven by agent-browser-flow-benchmark.mjs, and its
// statistics. Pure: `post` sends one browser tool request and resolves to
// { ok, body, bytes }, so this runs against a fake in unit tests.
//
// Strategy "selectors" is what an agent does with today's tool: it reads the
// page text, has no selectors, so it lists form controls with evaluate, waits
// and looks again when the form has not rendered yet, then fills, submits,
// waits for the result and takes a screenshot.

const LIST_CONTROLS = '[...document.querySelectorAll("input,select,textarea,button")].map((e) => ({ tag: e.tagName.toLowerCase(), id: e.id, name: e.name, type: e.type, label: (e.labels && e.labels[0] ? e.labels[0].innerText : e.innerText || "").trim() }))';

export async function runFlow(post, { url, strategy = 'selectors', name, email, maxRetries = 3 }) {
  const steps = [];
  let retries = 0;
  const started = performance.now();
  const call = async (step, input) => {
    const t = performance.now();
    const res = await post(input);
    const output = typeof res.body.output === 'string' ? res.body.output : '';
    steps.push({
      step, action: input.action, ok: res.ok, ms: Math.round((performance.now() - t) * 1000) / 1000,
      replyBytes: res.bytes,
      // What the model reads: the text of the reply or its error, and image data separately.
      textBytes: Buffer.byteLength(res.ok ? output : String(res.body.error ?? '')),
      imageBytes: res.body.image?.data ? Buffer.from(res.body.image.data, 'base64').length : 0,
    });
    return res;
  };
  const fail = (why) => ({ ...tally(), ok: false, error: why });
  const tally = () => ({
    totalMs: Math.round((performance.now() - started) * 1000) / 1000,
    calls: steps.length, retries,
    failedCalls: steps.filter((s) => !s.ok).length,
    textBytes: steps.reduce((n, s) => n + s.textBytes, 0),
    imageBytes: steps.reduce((n, s) => n + s.imageBytes, 0),
    replyBytes: steps.reduce((n, s) => n + s.replyBytes, 0),
    steps,
  });
  if (strategy !== 'selectors') throw new Error(`Unknown strategy ${strategy}`);

  const nav = await call('navigate', { action: 'navigate', url });
  if (!nav.ok) return fail('navigate: ' + nav.body.error);

  // Locate: list the form's controls; if the form has not rendered, wait and look again.
  let controls = [];
  for (let attempt = 0; ; attempt++) {
    const listed = await call('locate', { action: 'evaluate', expression: LIST_CONTROLS });
    if (!listed.ok) return fail('locate: ' + listed.body.error);
    controls = JSON.parse(listed.body.output);
    if (controls.some((c) => c.id === 'email')) break;
    if (attempt >= maxRetries) return fail('locate: no form');
    retries++;
    await call('locate-wait', { action: 'wait', text: 'Subscribe', timeout_ms: 5000 });
  }
  const byLabel = (label) => controls.find((c) => c.label === label && c.id);
  const emailField = byLabel('Email'), nameField = byLabel('Name');
  const submit = controls.find((c) => c.type === 'submit');
  if (!emailField || !nameField || !submit) return fail('locate: fields not identified');

  for (const [field, value] of [[emailField, email], [nameField, name]]) {
    const filled = await call('fill', { action: 'fill', selector: `#${field.id}`, value });
    if (!filled.ok) return fail('fill: ' + filled.body.error);
  }
  const clicked = await call('submit', { action: 'click', selector: 'button[type=submit]' });
  if (!clicked.ok) return fail('submit: ' + clicked.body.error);

  // Verify: the confirmation arrives after an API call.
  let verified = false;
  for (let attempt = 0; attempt <= maxRetries && !verified; attempt++) {
    if (attempt) retries++;
    const waited = await call('verify-wait', { action: 'wait', selector: '#result', timeout_ms: 5000 });
    if (!waited.ok) continue;
    const text = await call('verify', { action: 'extract', selector: '#result' });
    verified = text.ok && text.body.output.includes(name) && text.body.output.includes(email);
  }
  if (!verified) return fail('verify: confirmation not found');

  const shot = await call('capture', { action: 'screenshot' });
  if (!shot.ok || shot.body.image?.mime !== 'image/png') return fail('capture: ' + (shot.body.error ?? 'no image'));
  return { ...tally(), ok: true };
}

/** Nearest-rank percentile of numbers (p in 0..100). */
export function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];
}

const round = (n) => (n === null ? null : Math.round(n * 100) / 100);
const stats = (values) => ({ n: values.length, p50: round(percentile(values, 50)), p95: round(percentile(values, 95)), min: round(values.length ? Math.min(...values) : null), max: round(values.length ? Math.max(...values) : null) });

/** Per driver, scenario and strategy: flow time, calls, retries, bytes, and phase medians. */
export function summarize(flows) {
  const groups = new Map();
  for (const flow of flows) {
    if (flow.scenario === 'warmup' || flow.scenario === 'warm-open') continue;
    const key = `${flow.driver}/${flow.scenario}/${flow.strategy}${flow.scenario === 'process-first' ? (flow.firstInProcess ? '/first-driver' : '/second-driver') : ''}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(flow);
  }
  const out = {};
  for (const [key, list] of [...groups].sort()) {
    const ok = list.filter((f) => f.ok);
    const phases = {};
    for (const flow of ok) {
      // The navigate request carries startup on a fresh chat.
      const first = flow.timings?.find((t) => t.action === 'navigate');
      for (const phase of first?.phases ?? []) (phases[phase.phase] ??= []).push(phase.ms);
    }
    const stepsByName = {};
    for (const flow of ok) {
      const perStep = {};
      for (const s of flow.steps) perStep[s.step] = (perStep[s.step] ?? 0) + s.ms;
      for (const [name, ms] of Object.entries(perStep)) (stepsByName[name] ??= []).push(ms);
    }
    const failures = {};
    for (const f of list) if (!f.ok) failures[f.error] = (failures[f.error] ?? 0) + 1;
    out[key] = {
      flows: list.length, passed: ok.length, failures,
      totalMs: stats(ok.map((f) => f.totalMs)),
      calls: stats(ok.map((f) => f.calls)),
      retries: { total: ok.reduce((n, f) => n + f.retries, 0), flowsWithRetry: ok.filter((f) => f.retries > 0).length },
      textBytes: stats(ok.map((f) => f.textBytes)),
      imageBytes: stats(ok.map((f) => f.imageBytes)),
      fixtureRequests: stats(ok.map((f) => f.served?.total ?? 0)),
      cachedAssetRequests: stats(ok.map((f) => f.served?.assets ?? 0)),
      navigatePhasesMs: Object.fromEntries(Object.entries(phases).map(([k, v]) => [k, stats(v)])),
      stepMs: Object.fromEntries(Object.entries(stepsByName).map(([k, v]) => [k, stats(v)])),
    };
  }
  return out;
}
