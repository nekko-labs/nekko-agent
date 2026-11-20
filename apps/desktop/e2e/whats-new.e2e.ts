// Journey: finding out what changed in this version. The "What's new" sheet,
// opened by hand from the title-bar pill after an update, Settings > Updates,
// About and the command palette; its highlights, "Show more" (the list scrolls,
// the sheet keeps its size), the link to the website's What's new page, a version
// with no highlights, and opening by itself once after an update to a newer line
// (not after a nightly, not while an agent is running, not again once closed, not
// with "Show after updates" off).
import { expect, scenarioTest } from './harness';

const test = scenarioTest('whats-new', { width: 1100, height: 720 });

const EMPTY_VERSION = '0.98.1000';
const LONG_VERSION = '0.97.1000';
const LONG_COUNT = 14;

interface Highlight { title: string; detail: string; pr: number }
interface Expected { top: Highlight[]; rest: Highlight[]; release: string }

test("what's new", async ({ scenario, shot }) => {
  const { page } = scenario;
  const sheet = page.locator('[data-whats-new]');
  const rows = sheet.locator('[data-whats-new-row]');
  const list = sheet.locator('[data-whats-new-list]');
  const dialog = page.getByRole('dialog', { name: "What's new" });
  const close = sheet.getByRole('button', { name: 'Close' });
  const more = sheet.locator('[data-whats-new-more]');
  const everyChange = sheet.locator('[data-whats-new-all]');
  const pill = page.getByTestId('update-whats-new');
  const fromSettings = page.getByTestId('settings-whats-new');
  const launch = (v: string, from?: string) => page.evaluate(([next, last]) => (window as any).integration.launch(next, last), [v, from] as const);
  const relaunch = () => page.evaluate(() => (window as any).integration.relaunch());
  const lastOpened = () => page.evaluate(() => (window as any).integration.opened.at(-1));
  const theme = (t: string) => page.evaluate((v) => { document.documentElement.dataset.theme = v; }, t);
  // The sheet's box once it has arrived, to the pixel: layout rounds a locked height to 1/64px.
  const box = async () => {
    await dialog.evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)));

    return Object.values((await dialog.boundingBox())!).map(Math.round);
  };
  // The two faces of one setting: the sheet's footer and Settings > Updates.
  const footerSwitch = sheet.getByRole('switch', { name: 'Show after updates' });
  const settingsSwitch = page.getByRole('switch', { name: "Show what's new after updates" });
  /** A launch on `v` after `from`, on an install that has not shown the sheet for any line yet. */
  const fresh = (v: string, from: string) => page.evaluate(([next, last]) => {
    (window as any).integration.forget();
    (window as any).integration.launch(next, last);
  }, [v, from] as const);
  const running = (ids: string[]) => page.evaluate((x) => (window as any).integration.running(x), ids);
  // What the launch decided can only be seen by waiting: it opens within one frame of the version arriving.
  const settle = () => page.waitForTimeout(500);
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

  await test.step('the pill can be dismissed without opening the sheet, and stays gone', async () => {
    const dismiss = page.getByTestId('update-dismiss');

    await expect(page.getByRole('group', { name: `Updated to v${VERSION}` })).toBeVisible();
    await expect(dismiss).toHaveAccessibleName('Dismiss');
    await shot('r5-pill-dark');
    await theme('light'); await shot('r5-pill-light'); await theme('dark');

    // Two buttons: Tab goes from one to the other.
    await pill.focus();
    await page.keyboard.press('Tab');
    await expect(dismiss).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(pill).toHaveCount(0);
    await expect(dismiss).toHaveCount(0);
    await expect(sheet).toHaveCount(0);

    // Focus lands on the version pill that takes its place.
    await expect(page.locator('.update-version')).toBeFocused();
    await relaunch();
    await expect(page.locator('.update-version')).toBeVisible();
    await expect(pill).toHaveCount(0);
    await launch(VERSION, `${line}.1000`);
  });

  await test.step('the pill after an update opens the sheet and goes away', async () => {
    // Only "What's new" shows; the name still says an update was installed.
    await expect(pill).toHaveText("What's new");
    await expect(pill).toHaveAccessibleName(`Updated to v${VERSION}. What's new`);
    await expect(page.locator('[data-fixture-titlebar]')).not.toContainText('Updated to');
    await shot('pill-dark');
    await theme('light'); await shot('pill-light'); await theme('dark');
    await pill.click();
    await expect(sheet).toHaveAttribute('data-whats-new', VERSION);
    await expect(dialog).toBeVisible();
    await expect(pill).toHaveCount(0);
  });

  await test.step('it shows three highlights, each with its pull request', async () => {
    await expect(rows).toHaveCount(top.length);
    await expect(rows.first()).toContainText(top[0]!.title);
    await expect(rows.first()).toContainText(top[0]!.detail);
    await expect(rows.first()).toContainText(`#${top[0]!.pr}`);
    // Every icon is Gentleface: one per row, and the close button's.
    await expect(rows.locator('[data-gf-icon]')).toHaveCount(top.length);
    await expect(close.locator('[data-gf-icon="x"]')).toHaveCount(1);
    await shot('sheet-dark');
    await theme('light'); await shot('sheet-light'); await theme('dark');
    await rows.first().click();
    expect(await lastOpened()).toBe(await prUrl(top[0]!.pr));
  });

  if (rest.length > 0) await test.step('Show more lists the rest and the sheet keeps its size', async () => {
    const before = await box();
    await expect(more).toHaveText('Show more');
    await more.click();
    await expect(rows).toHaveCount(top.length + rest.length);
    await expect(more).toHaveCount(0);
    await expect(rows.nth(top.length)).toBeFocused();
    await expect(rows.nth(top.length)).toBeInViewport({ ratio: 0.99 });
    expect(await box()).toEqual(before);
    await shot('sheet-expanded-dark');
    await theme('light'); await shot('sheet-expanded-light'); await theme('dark');
  });

  await test.step("See every change opens this line's section of the website's What's new page", async () => {
    await everyChange.click();
    expect(await lastOpened()).toBe(release);
    expect(release).toBe(`https://nekkoagent.com/whatsnew#${line}`);
  });

  await test.step('Escape closes it', async () => {
    await page.keyboard.press('Escape');
    await expect(sheet).toHaveCount(0);
  });

  await test.step('Settings opens it, and the close button returns focus there', async () => {
    await fromSettings.click();
    await expect(sheet).toBeVisible();
    // Reopened, it starts collapsed again.
    await expect(rows).toHaveCount(top.length);
    await close.click();
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

  // Opening by itself: the newest line the build bundles, after a version in the line before it.
  const ordered = Object.keys(lines).sort((a, b) => {
    const [x, y] = [a, b].map((l) => l.split('.').map(Number)) as [number[], number[]];
    return x[0]! - y[0]! || x[1]! - y[1]!;
  });
  const NEWEST = ordered.at(-1)!;
  const BUMPED = `${NEWEST}.1000`;
  const BEFORE = `${ordered.at(-2)!}.1004`;

  await test.step('after an update to a newer line it opens by itself, in place of the pill', async () => {
    // The last step's launch has read its version: a launch still starting would record its own as the last one.
    await expect(page.locator('.update-version')).toContainText(VERSION);
    await fresh(BUMPED, BEFORE);
    await expect(sheet).toHaveAttribute('data-whats-new', BUMPED);
    await expect(pill).toHaveCount(0);
    await expect(footerSwitch).toHaveAttribute('aria-checked', 'true');
    await expect(more).toBeVisible();
    await shot('auto-open-dark');
    await theme('light'); await shot('auto-open-light'); await theme('dark');
    await page.keyboard.press('Escape');
    await expect(sheet).toHaveCount(0);
  });

  await test.step('not again once closed, on a restart or the same update seen again', async () => {
    await relaunch();
    await settle();
    await expect(sheet).toHaveCount(0);
    await launch(BUMPED, BEFORE);
    await settle();
    await expect(sheet).toHaveCount(0);
    await expect(pill).toBeVisible();
  });

  await test.step('not after a nightly in the same line', async () => {
    await fresh(`${NEWEST}.1005`, `${NEWEST}.1004`);
    await settle();
    await expect(sheet).toHaveCount(0);
    await expect(pill).toBeVisible();
  });

  await test.step('not on a first install', async () => {
    await page.evaluate(() => localStorage.removeItem('op_last_version'));
    await page.evaluate(() => (window as any).integration.forget());
    await relaunch();
    await settle();
    await expect(sheet).toHaveCount(0);
  });

  await test.step('it waits while an agent is running, then opens', async () => {
    await running(['agent-1']);
    await fresh(BUMPED, BEFORE);
    await settle();
    await expect(sheet).toHaveCount(0);
    await expect(pill).toBeVisible();
    await running([]);
    await expect(sheet).toHaveAttribute('data-whats-new', BUMPED);
    await expect(pill).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(sheet).toHaveCount(0);
  });

  await test.step('still waiting when the app quits, it opens on the next launch', async () => {
    await running(['agent-1']);
    await fresh(BUMPED, BEFORE);
    await settle();
    await relaunch();
    await settle();
    await expect(sheet).toHaveCount(0);
    await running([]);
    await expect(sheet).toHaveAttribute('data-whats-new', BUMPED);
    // The sheet takes focus once it is ready for keys.
    await expect(close).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(sheet).toHaveCount(0);
  });

  await test.step('the switch in Settings stops it, and is the footer switch', async () => {
    await expect(settingsSwitch).toHaveAttribute('aria-checked', 'true');
    await shot('settings-switch-dark');
    await theme('light'); await shot('settings-switch-light'); await theme('dark');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await settingsSwitch.click();
    await expect(settingsSwitch).toHaveAttribute('aria-checked', 'false');
    await fresh(BUMPED, BEFORE);
    await settle();
    await expect(sheet).toHaveCount(0);

    // The pill and the other ways in stay.
    await expect(pill).toBeVisible();
    await fromSettings.click();
    await expect(footerSwitch).toHaveAttribute('aria-checked', 'false');
    await footerSwitch.click();
    await expect(footerSwitch).toHaveAttribute('aria-checked', 'true');
    await page.keyboard.press('Escape');
    await expect(settingsSwitch).toHaveAttribute('aria-checked', 'true');
  });

  // A release with many changes: the list scrolls inside a sheet that does not grow.
  const longList = async (label: string) => {
    await fromSettings.click();
    await expect(rows).toHaveCount(3);
    const before = await box();
    await shot(`long-${label}-dark`);

    await more.click();
    await expect(rows).toHaveCount(LONG_COUNT);
    expect(await box(), 'the sheet keeps its size').toEqual(before);
    expect(await list.evaluate((el) => el.scrollHeight > el.clientHeight), 'the list scrolls').toBe(true);

    // By keyboard alone: Shift+Tab from the first control wraps to the footer, its switch, then back to the last row.
    await close.focus();
    await page.keyboard.press('Shift+Tab');
    await expect(everyChange).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(footerSwitch).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(rows.last()).toBeFocused();
    await expect(rows.last()).toBeInViewport({ ratio: 0.99 });
    await expect(rows.first()).not.toBeInViewport();

    // The header, the close button and the footer stay put.
    await expect(close).toBeInViewport({ ratio: 0.99 });
    await expect(everyChange).toBeInViewport({ ratio: 0.99 });
    expect(await box()).toEqual(before);
    await shot(`long-${label}-scrolled-dark`);
    await theme('light'); await shot(`long-${label}-scrolled-light`); await theme('dark');

    // Focus stays in the sheet: Tab from the footer wraps to the close button.
    await everyChange.focus();
    await page.keyboard.press('Tab');
    await expect(close).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(sheet).toHaveCount(0);
  };

  await test.step('a long list scrolls inside the sheet', async () => {
    await page.evaluate((n) => (window as any).integration.long(n), LONG_COUNT);
    // Its line counts as seen, so the sheet does not open by itself (covered above).
    await page.evaluate((l) => (window as any).integration.seen(l), LONG_VERSION.split('.').slice(0, 2).join('.'));
    await launch(LONG_VERSION);
    await longList('desktop');
  });

  await test.step('it fits a 360px window, long list included', async () => {
    await scenario.resize(360, 720);
    await launch(VERSION, `${line}.1000`);
    await expect(page.getByTestId('update-dismiss')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
    await shot('r5-pill-360-dark');
    await theme('light'); await shot('r5-pill-360-light'); await theme('dark');
    await launch(VERSION);
    await fromSettings.click();
    await expect(sheet).toBeVisible();
    const at = await dialog.boundingBox();
    expect(at!.x).toBeGreaterThanOrEqual(0);
    expect(at!.x + at!.width).toBeLessThanOrEqual(360);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
    await shot('sheet-360-dark');
    await theme('light'); await shot('sheet-360-light'); await theme('dark');
    await page.keyboard.press('Escape');
    await launch(LONG_VERSION);
    await longList('360');
  });
});
