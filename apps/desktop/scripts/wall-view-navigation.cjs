// Drive the shipped controls, not fixture state or a layout keyboard shortcut.
async function selectWallView(run, mode, settle) {
  if (!['focus', 'grid'].includes(mode)) throw Error('Unknown wall view ' + mode);
  await run(`(() => {
    const toggle = document.querySelector('[data-wall-view-toggle]');
    if (!toggle) throw Error('Missing View toggle');
    if (toggle.getAttribute('aria-expanded') !== 'true') toggle.click();
  })()`);
  await settle();
  await run(`(() => {
    const radio = document.querySelector('[data-wall-view-menu] input[data-view-mode="${mode}"]');
    if (!radio || radio.disabled) throw Error('Missing enabled View radio: ${mode}');
    radio.click();
  })()`);
  await settle();
  await run(`(() => {
    const radio = document.querySelector('[data-wall-view-menu] input[data-view-mode="${mode}"]');
    if (!radio?.checked || !document.querySelector('[data-wall-layout="${mode}"]')) throw Error('View selection did not apply: ${mode}');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  })()`);
  await settle();
  await run(`(() => {
    if (document.querySelector('[data-wall-view-menu]')) throw Error('Escape did not dismiss View menu');
  })()`);
}

module.exports = { selectWallView };
