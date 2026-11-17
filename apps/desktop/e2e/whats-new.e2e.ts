// Journey: finding out what changed in this version. The "What's new" sheet,
// opened by hand from the title-bar pill after an update, Settings > Updates,
// About and the command palette; its highlights, "Show N more", the link to
// the full release notes, and a version with no highlights.
import { expect, scenarioTest } from './harness';

const test = scenarioTest('whats-new', { width: 1100, height: 720 });

const EMPTY_VERSION = '0.98.1000';

interface Highlight { title: string; detail: string; pr: number }
interface Expected { top: Highlight[]; rest: Highlight[]; release: string }

test("what's new", async ({ scenario, shot }) => {
  const { page } = scenario;
  const sheet = page.locator('[data-whats-new]');
  const rows = sheet.locator('[data-whats-new-row]');
  // Rows behind "Show N more" are in the page but inert and folded to no height.
  const shown = sheet.locator('[data-whats-new-row]:not([inert] *)');
  const more = sheet.locator('[data-whats-new-more]');
  const everyChange = sheet.locator('[data-whats-new-all]');
  const pill = page.getByTestId('update-whats-new');
  const fromSettings = page.getByTestId('settings-whats-new');
  const launch = (v: string, from?: string) => page.evaluate(([next, last]) => (window as any).integration.launch(next, last), [v, from] as const);
  const lastOpened = () => page.evaluate(() => (window as any).integration.opened.at(-1));
  const theme = (t: string) => page.evaluate((v) => { document.documentElement.dataset.theme = v; }, t);
  const focused = (testId: string) => page.evaluate((id) => document.activeElement?.getAttribute('data-testid') === id, testId);

  // The line with the most highlights, so the journey follows whatever the build bundles.
  const lines: Record<string, number> = await page.evaluate(() => (window as any).integration.lines);
  const line = Object.entries(lines).sort((a, b) => b[1] - a[1])[0]![0];
  const VERSION = `${line}.1004`;
  const expected = (v: string): Promise<Expected> => page.evaluate((x) => (window as any).integration.expected(x), v);
  const prUrl = (pr: number): Promise<string> => page.evaluate((x) => (window as any).integration.prUrl(x), pr);
  const { top, rest, release } = await expected(VERSION);

  expect(top.length, 'the bundled line has highlights').toBeGreaterThan(0);
  expect((await expected(EMPTY_VERSION)).top, 'the empty version must stay empty').toEqual([]);
  await theme('dark');
  await launch(VERSION, `${line}.1000`);

  await test.step('the pill after an update opens the sheet and goes away', async () => {
    await expect(pill).toBeVisible();
    await shot('pill-dark');
    await pill.click();
    await expect(sheet).toHaveAttribute('data-whats-new', VERSION);
    await expect(page.getByRole('dialog', { name: "What's new" })).toBeVisible();
    await expect(pill).toHaveCount(0);
  });

  await test.step('it shows three highlights, each with its pull request', async () => {
    await expect(shown).toHaveCount(top.length);
    await expect(rows.first()).toContainText(top[0]!.title);
    await expect(rows.first()).toContainText(top[0]!.detail);
    await expect(rows.first()).toContainText(`#${top[0]!.pr}`);
    // Every icon is Gentleface: one per row, and the close button's.
    await expect(shown.locator('[data-gf-icon]')).toHaveCount(top.length);
    await expect(sheet.getByRole('button', { name: 'Close' }).locator('[data-gf-icon="x"]')).toHaveCount(1);
    await shot('sheet-dark');
    await theme('light'); await shot('sheet-light'); await theme('dark');
    await rows.first().click();
    expect(await lastOpened()).toBe(await prUrl(top[0]!.pr));
  });

  if (rest.length > 0) await test.step('Show N more opens the rest in place', async () => {
    await expect(more).toHaveText(`Show ${rest.length} more`);
    await more.click();
    await expect(shown).toHaveCount(top.length + rest.length);
    await expect(more).toHaveCount(0);
    await expect(rows.nth(top.length)).toBeFocused();
    await shot('sheet-expanded-dark');
  });

  await test.step("See every change opens this version's release page", async () => {
    await everyChange.click();
    expect(await lastOpened()).toBe(release);
    expect(release).toContain(`/releases/tag/v${VERSION}`);
  });

  await test.step('Escape closes it', async () => {
    await page.keyboard.press('Escape');
    await expect(sheet).toHaveCount(0);
  });

  await test.step('Settings opens it, and the close button returns focus there', async () => {
    await fromSettings.click();
    await expect(sheet).toBeVisible();
    // Reopened, it starts collapsed again.
    await expect(shown).toHaveCount(top.length);
    await sheet.getByRole('button', { name: 'Close' }).click();
    await expect(sheet).toHaveCount(0);
    await expect.poll(() => focused('settings-whats-new')).toBe(true);
  });

  await test.step('a click outside closes it', async () => {
    await fromSettings.click();
    await expect(sheet).toBeVisible();
    await page.mouse.click(8, 8);
    await expect(sheet).toHaveCount(0);
  });

  await test.step('About opens it in place of itself', async () => {
    await page.evaluate(() => (window as any).integration.about());
    const about = page.getByRole('dialog', { name: 'About Nekko Agent' });
    await expect(about).toBeVisible();
    await shot('about-dark');
    await page.getByTestId('about-whats-new').click();
    await expect(about).toHaveCount(0);
    await expect(sheet).toBeVisible();
    await page.keyboard.press('Escape');
  });

  await test.step('the command palette finds and opens it', async () => {
    await page.evaluate(() => (window as any).integration.palette());
    const box = page.getByRole('combobox', { name: 'Search everything' });
    await box.fill('whats new');
    await expect(page.getByRole('option').first()).toContainText("What's new");
    await box.press('Enter');
    await expect(sheet).toBeVisible();
    await expect(page.getByRole('dialog')).toHaveCount(1);
    await page.keyboard.press('Escape');
    await expect(sheet).toHaveCount(0);
  });

  await test.step('a version with no highlights shows only the link', async () => {
    await launch(EMPTY_VERSION);
    await expect(pill).toHaveCount(0);
    await fromSettings.click();
    await expect(sheet).toHaveAttribute('data-whats-new', EMPTY_VERSION);
    await expect(rows).toHaveCount(0);
    await expect(more).toHaveCount(0);
    await expect(everyChange).toBeVisible();
    await shot('sheet-empty-dark');
    await page.keyboard.press('Escape');
    await launch(VERSION);
  });

  await test.step('it fits a 360px window', async () => {
    await scenario.resize(360, 720);
    await fromSettings.click();
    await expect(sheet).toBeVisible();
    const box = await page.getByRole('dialog', { name: "What's new" }).boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(360);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
    await shot('sheet-360-dark');
    await theme('light'); await shot('sheet-360-light');
    await page.keyboard.press('Escape');
  });
});
