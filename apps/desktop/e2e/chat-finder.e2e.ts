// Journey: the chat finder popup in the Agents panel. Scopes, debounced
// search, message hits seeding Find in chat, groups, providers, the date range
// and narrow windows. Ported from scripts/chat-finder-sandbox.cjs.
import { expect, scenarioTest } from './harness';

const test = scenarioTest('chat-finder', { width: 1100, height: 720 });

test('chat finder', async ({ scenario, shot }) => {
  const { page } = scenario;
  const finder = page.locator('[data-chat-finder]');
  const input = finder.locator('input');
  const rows = page.locator('[data-finder-row]');
  const ids = () => rows.evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.finderRow));
  const facets = () => page.locator('[data-finder-facet]').evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.finderFacet));
  const opened = () => page.evaluate(() => (window as any).integration.opened.at(-1));
  const open = async () => { await page.locator('[data-chat-finder-toggle]').click(); await expect(finder).toBeVisible(); };
  const search = async (text: string) => { await input.fill(text); await input.press('Enter'); };
  const theme = (t: string) => page.evaluate((v) => { document.documentElement.dataset.theme = v; }, t);
  const day = (ago: number) => page.evaluate((d) => { const t = new Date(); t.setHours(0, 0, 0, 0); t.setDate(t.getDate() - d); return t.toDateString(); }, ago);

  await theme('dark');
  await open();

  await test.step('opens on All with the latest chats newest first', async () => {
    await shot('popup-latest-dark');
    await theme('light'); await shot('popup-latest-light'); await theme('dark');
    const r = await ids();
    expect(r).toHaveLength(9);
    expect([r[0], r[8]]).toEqual(['s0', 's8']);
    await expect(page.locator('[data-finder-scope="all"]')).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('[data-finder-scope]')).toHaveCount(6);
    await expect(page.locator('[data-finder-date]')).toBeAttached();
  });

  await test.step('search waits 1 s after typing, then finds a word deep in the messages', async () => {
    await input.fill('kerning');
    await page.waitForTimeout(600);
    await expect(rows).toHaveCount(9);
    await expect(rows).toHaveCount(1, { timeout: 2_000 });
    await expect(rows.first()).toHaveAttribute('data-finder-row', 's1');
    await expect(rows.first()).toHaveAttribute('data-finder-kind', 'message');
    await shot('all-message-hit-dark');
  });

  await test.step('a message hit opens the chat and seeds Find in chat', async () => {
    await rows.first().click();
    expect(await opened()).toBe('s1');
    await expect(finder).toHaveCount(0);
    expect(await page.evaluate(() => (window as any).integration.findSeed())).toMatchObject({ query: 'kerning', sessionId: 's1' });
  });

  await test.step('Chats searches titles and descriptions only; Messages searches replies', async () => {
    await open();
    await page.locator('[data-finder-scope="chats"]').click();
    await search('kerning');
    await expect(rows).toHaveCount(0);
    await search('oauth');
    expect(await ids()).toEqual(['s5']);
    await page.locator('[data-finder-scope="messages"]').click();
    await search('stripe');
    await expect.poll(ids).toEqual(['s6']);
    await shot('messages-dark');
  });

  await test.step('Artifacts lists the linked report and opens its chat', async () => {
    await page.locator('[data-finder-scope="artifacts"]').click();
    await search('');
    const artifacts = page.locator('[data-finder-artifact]');
    await expect(artifacts).toHaveCount(1);
    await expect(artifacts).toHaveAttribute('data-finder-row', 's2');
    await shot('artifacts-dark');
    await artifacts.click();
    expect(await opened()).toBe('s2');
    await expect(finder).toHaveCount(0);
  });

  await test.step('Groups shows each group with its chats, and searches group names', async () => {
    await open();
    await page.locator('[data-finder-scope="groups"]').click();
    await expect.poll(facets).toEqual(['__none', 'w1', 'w2']);
    const w1 = page.locator('[data-finder-facet="w1"]');
    expect((await w1.locator('[data-finder-facet-more]').count()) > 0 || (await w1.locator('[data-finder-row]').count()) === 4).toBe(true);
    await shot('groups-dark');
    await search('website');
    await expect.poll(facets).toEqual(['w2']);
    await expect(page.locator('[data-finder-facet="w2"] [data-finder-row]')).toHaveCount(2);
    await page.locator('[data-finder-facet="w2"] [data-finder-row]').first().click();
    expect(await opened()).toBe('s3');
  });

  await test.step('Providers splits Local and Cloud, and "local" keeps only local ones', async () => {
    await open();
    await page.locator('[data-finder-scope="providers"]').click();
    await expect(page.locator('[data-finder-section="local"] [data-finder-facet="p:eng"]')).toBeAttached();
    await expect(page.locator('[data-finder-section="cloud"] [data-finder-facet="p:ant"]')).toBeAttached();
    await shot('providers-dark');
    await theme('light'); await shot('providers-light'); await theme('dark');
    await search('local');
    await expect.poll(facets).toEqual(['p:eng']);
    await page.locator('[data-finder-facet="p:eng"] [data-finder-row]').first().click();
    expect(await opened()).toBe('s2');
  });

  await test.step('date range: presets, two-click range, clear', async () => {
    await open();
    await page.locator('[data-finder-date]').click();
    await expect(page.locator('[data-finder-calendar] [data-day]')).toHaveCount(42);
    await page.locator('[data-finder-calendar] button', { hasText: /^7 days$/ }).click();
    await expect.poll(ids).toEqual(['s0', 's1', 's2']);
    await shot('range-results-dark');

    await page.locator('[data-finder-range-label]').click();
    const cell = async (ago: number) => page.locator(`[data-finder-calendar] [aria-label="${await day(ago)}"]`);
    if (!(await (await cell(13)).count())) await page.getByLabel('Previous month').click();
    await (await cell(13)).click();
    await shot('calendar-picking-dark');
    if (!(await (await cell(11)).count())) await page.getByLabel('Next month').click();
    await (await cell(11)).click();
    await expect.poll(ids).toEqual(['s3']);
    await expect(page.locator('[data-finder-calendar]')).toHaveCount(0);

    await page.locator('[data-finder-range-x]').click();
    await expect(rows).toHaveCount(9);
    await page.locator('[data-finder-date]').click();
    await shot('calendar-dark');
    await theme('light'); await shot('calendar-light'); await theme('dark');
  });

  await test.step('Esc closes the calendar first, then the popup', async () => {
    await input.press('Escape');
    await expect(page.locator('[data-finder-calendar]')).toHaveCount(0);
    await expect(finder).toBeVisible();
    await input.press('Escape');
    await expect(finder).toHaveCount(0);
  });

  await test.step('the popup fits a narrow window', async () => {
    await scenario.resize(360, 640);
    // Below 768 px the agent list is collapsed; the finder is reached through it.
    await page.getByLabel('Open agent list').click();
    await open();
    const fits = await finder.evaluate((e) => { const r = e.getBoundingClientRect(); return r.left >= 0 && r.right <= window.innerWidth; });
    expect(fits).toBe(true);
    await shot('narrow-dark');
  });
});
