// Capture the System prompt size Settings section in isolated hidden windows.
const { app, BrowserWindow, session } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT;
if (!out) throw Error('Launch through layout-evidence-integration.cjs');
const baseline = process.env.NEKKO_PROMPT_PROFILES_BASELINE === '1';
app.setPath('userData', path.join(out, 'profile'));
if (process.platform === 'darwin') app.setActivationPolicy('accessory');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const model = '#prompt-profile-instructions-model';
const field = '#prompt-profile-instructions-text';
const js = (v) => JSON.stringify(v).replace(/[<>/\u2028\u2029]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
const checkUi = (key, value) => `(() => {
  const node = document.querySelector(${js(key)});
  return !!node && node.value === ${js(value)};
})()`;
const select = key => `(() => {
  const node = document.querySelector(${js(model)});
  node.value = ${js(key)};
  node.dispatchEvent(new Event('change', { bubbles: true }));
})()`;
const edit = text => `(() => {
  const node = document.querySelector(${js(field)});
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(node, ${js(text)});
  node.dispatchEvent(new Event('input', { bubbles: true }));
})()`;
const save = `[...document.querySelectorAll('button')].find(b => b.textContent === 'Save instructions')`;

app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((d, done) => done({ cancel: !/^(file:|data:|blob:|devtools:)/.test(d.url) }));
  const report = [];
  const win = new BrowserWindow({ width: 800, height: 1020, useContentSize: true, show: false, focusable: false, skipTaskbar: true, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  const run = s => win.webContents.executeJavaScript(s, true);
  for (const [size, width, height] of [['desktop', 800, 1020], ['narrow', 390, 1100]]) {
    for (const theme of ['dark', 'light']) {
      win.setContentSize(width, height);
      await win.loadFile(path.join(out, 'index.html'));
      await run(`document.documentElement.dataset.theme = '${theme}'`);
      await sleep(300);
      await run(`[...document.querySelectorAll('[role=tab]')].find(b => b.textContent === 'Small').click()`);
      assert.equal(await run(`document.querySelector('[role=tabpanel]').getAttribute('aria-label')`), 'Small built-in prompt');
      const sizeSelector = '[id="prompt-profile-model-lm::gemma-4-31b"]';
      if (baseline) {
        assert.equal(await run(`!!document.querySelector('${model}')`), false);
      } else {
        await run(select('lm::gemma-4-31b'));
        assert.equal(await run(checkUi(field, '')), true);
        const text = 'Use numbered steps.\nCite relevant files.';
        await run(edit(text));
        assert.equal(await run(`${save}.disabled`), false);
        await run(`${save}.click()`);
        assert.equal(await run(`${save}.disabled`), true);
        await run(select('lm::qwen3-8b'));
        assert.equal(await run(checkUi(field, '')), true);
        await run(select('lm::gemma-4-31b'));
        assert.equal(await run(checkUi(field, text)), true);
      }
      assert.equal(await run(checkUi(sizeSelector, 'medium')), true);
      const layout = await run(`(() => {
        const section = document.querySelector('#prompt-profiles').getBoundingClientRect();
        const textarea = document.querySelector('${field}')?.getBoundingClientRect();
        return { sectionBottom: section.bottom, fieldWidth: textarea?.width ?? 0, fieldRight: textarea?.right ?? 0, viewport: [innerWidth, innerHeight] };
      })()`);
      assert.deepEqual(layout.viewport, [width, height]);
      assert.ok(layout.sectionBottom < height && layout.fieldRight <= width, `the section and editor fit on ${size}/${theme}: ${JSON.stringify(layout)}`);
      assert.equal(win.isVisible(), false);
      assert.equal(win.isFocusable(), false);
      // The first capture can still return the prior frame after a hidden resize.
      await win.capturePage(undefined, { stayHidden: true });
      await sleep(200);
      fs.writeFileSync(path.join(out, `prompt-profiles-${size}-${theme}.png`), (await win.capturePage(undefined, { stayHidden: true })).toPNG());
      if (!baseline) {
        await run(edit(''));
        await run(`${save}.click()`);
        await run(select('lm::qwen3-8b'));
        await run(select('lm::gemma-4-31b'));
        assert.equal(await run(checkUi(field, '')), true);
        assert.equal(await run(checkUi(sizeSelector, 'medium')), true);
      }
      report.push({ size, theme, visible: win.isVisible(), focusable: win.isFocusable(), bounds: win.getBounds(), layout, baseline });
    }
  }
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  win.destroy();
  app.exit(0);
}).catch(e => { console.error(e); app.exit(1); });
