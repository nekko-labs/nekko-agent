// Journey: the Agents sidebar. Archived chats, the reader, creating agents and
// terminals, context actions, drag to refile, restore and delete.
// Ported from scripts/agent-sidebar-sandbox.cjs.
import { expect, scenarioTest } from './harness';

const test = scenarioTest('command-center');

for (const theme of ['light', 'dark'] as const) for (const width of [1200, 400]) {
  test(`agents sidebar, ${theme}, ${width}px`, async ({ scenario, shot }) => {
    const { page } = scenario;
    const state = <T>(fn: string) => page.evaluate(`(${fn})((window).integration)`) as Promise<T>;
    const called = (fn: string) => expect.poll(() => state<boolean>(`(i) => i.calls.some(${fn})`)).toBe(true);
    // Below 768 px the list is a drawer; open it unless it already is.
    const openList = async () => {
      if (width >= 768) return;
      const toggle = page.getByLabel('Open agent list');
      if (await toggle.isVisible() && await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
    };
    const card = (title: string) => page.locator(`div[role=button][title*="${title}"]`).first();

    await scenario.resize(width);
    // Archived chats folded under their project, project + buttons and drag to
    // refile all belong to Project grouping, no longer the default. The reset
    // remounts on the next render, so the panel reads this view when it mounts.
    await page.evaluate(`integration.reset(); localStorage.setItem('nekko.agentPanelView', JSON.stringify({ groupBy: 'project' }))`);
    await page.evaluate(`(() => {
      document.documentElement.dataset.theme = '${theme}';
      const archived = integration.records()[0];
      Object.assign(archived, { archivedAt: Date.now(), id: 'archived', title: 'Archived conversation' });
      integration.records().push({ ...archived, id: 'active', title: 'Active conversation', archivedAt: undefined });
      integration.records().push({ ...archived, id: 'project-archived', title: 'Archived project conversation', workspaceId: 'finished-project' });
      const s = integration.state();
      s.settings.workspaces.push({ id: 'finished-project', name: 'Finished project', path: '/synthetic/finished' });
      s.refreshSessions();
    })()`);

    await test.step('archived-only project stays reachable', async () => {
      await openList();
      await page.locator('[data-archived-toggle]').evaluateAll((els) => els.forEach((b) => (b as HTMLElement).click()));
      await expect(page.locator('[data-archived-row=project-archived]')).toBeAttached();
      await shot(`agents-${theme}-${width}`);
    });

    await test.step('an archived chat opens read-only', async () => {
      // The sticky group heading intercepts pointer events at the top of the
      // list; dispatch directly so the test does not depend on scroll state.
      await page.locator('[data-archived-row=archived]').evaluate((el) => (el as HTMLElement).click());
      await expect(page.getByText('Back to active agents')).toBeVisible();
      await expect(page.locator('[data-wall-composer]')).toHaveCount(0);
      await shot(`archived-${theme}-${width}`);
      await page.getByRole('button', { name: 'Back to active agents', exact: true }).click();
    });

    await test.step('the emptied board keeps its zones', async () => {
      // The board's only chat became the archived one. With zones (Dynamic view:
      // zones) its zone stays, dotted with the Agent, media and Terminal buttons, so the wall is never
      // empty: no switch to the Focused new-chat screen, no "The wall is empty".
      await expect(page.locator('[data-wall-layout]')).toHaveAttribute('data-wall-layout', 'grid');
      await expect(page.locator('[data-command-wall]').getByText('Empty zone').first()).toBeVisible();
      await expect(page.locator('[data-command-wall]').getByRole('button', { name: 'Agent', exact: true }).first()).toBeVisible();
      await expect(page.locator('[data-wall-empty]')).toHaveCount(0);
      await expect(page.locator('[data-clean-start-greeting]')).toHaveCount(0);
      await shot(`empty-zones-${theme}-${width}`);
    });

    await test.step('an active card selects its window outside Focus', async () => {
      await expect(page.locator('[data-wall-layout]')).toHaveAttribute('data-wall-layout', 'grid');
      await openList();
      // The sticky group heading can intercept pointer events; dispatch directly.
      await card('Active conversation').evaluate((el) => (el as HTMLElement).click());
      expect(await state<string>('(i) => i.state().view')).toBe('command');
      await expect(page.locator('[data-wall-layout]')).toHaveAttribute('data-wall-layout', 'grid');
      await expect(page.locator('[data-wall-selected]')).toHaveAttribute('data-grid-cell', 'chat:active');
    });

    if (width >= 768) await test.step('keyboard resize persists', async () => {
      await page.getByLabel('Resize the agent list').dispatchEvent('keydown', { key: 'ArrowRight' });
      await expect.poll(() => page.evaluate(() => localStorage.getItem('nekko.wsSidebarWidth'))).toBe('272');
    });

    await test.step('create an agent, a media agent and a terminal', async () => {
      await page.evaluate('integration.calls.length = 0');
      // Suppress the per-kind first-use modals that appear on the first Photo
      // or Video session; they would overlay the next create-menu click.
      await page.evaluate(() => {
        localStorage.setItem('nekko.media-intro.image.v1', 'seen');
        localStorage.setItem('nekko.media-intro.video.v1', 'seen');
      });
      await openList();
      const create = async (label: string) => {
        await page.locator('[data-agent-panel]').getByRole('button', { name: 'New agent', exact: true }).dispatchEvent('focusin');
        await page.locator('.create-row', { hasText: label }).first().click();
        expect(await state<string>('(i) => i.state().view'), `${label} stays in Agents`).toBe('command');
      };
      const creates = () => state<number>(`(i) => i.calls.filter((c) => c.method === 'create').length`);
      const before = await creates();
      await create('Agent');
      await expect.poll(creates).toBeGreaterThan(before);
      await create('Photo');
      await called(`(c) => c.method === 'options' && c.options.chatType === 'image'`);
      await create('Video');
      await called(`(c) => c.method === 'options' && c.options.chatType === 'video'`);
      await create('Terminal');
      await called(`(c) => c.method === 'terminal'`);
      expect(await state<number>('(i) => i.state().terminals.length')).toBe(1);
    });

    await test.step('card context menu keeps its actions', async () => {
      // The sticky group heading intercepts pointer events at narrow widths; dispatch directly.
      await card('Active conversation').evaluate((el) => el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })));
      await expect(page.getByRole('menuitem', { name: 'Archive', exact: true })).toBeVisible();
      await expect(page.getByText('Change model')).toBeVisible();
      await page.keyboard.press('Escape');
      await page.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    });

    await test.step('dragging a card onto a group refiles it and saves the order', async () => {
      // Synthetic DOM drag checks the host payload; real pointer drags are not covered here.
      await page.evaluate(() => {
        const c = [...document.querySelectorAll('div[role=button]')].find((e) => e.getAttribute('title')?.includes('Active conversation'))!;
        c.parentElement!.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: new DataTransfer() }));
      });
      await page.waitForTimeout(100);
      await page.evaluate(() => {
        const g = [...document.querySelectorAll('[data-sidebar-group]')].find((e) => e.textContent!.includes('Finished project'))!;
        g.closest('.mb-1')!.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: new DataTransfer() }));
      });
      await called(`(c) => c.method === 'workspace' && c.id === 'active' && c.workspaceId === 'finished-project'`);
      await called(`(c) => c.method === 'options' && c.id === 'active' && c.options.order === 0`);
    });

    await test.step('Archive stops and archives the owning chat', async () => {
      await card('Active conversation').evaluate((el) => el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })));
      await page.getByRole('menuitem', { name: 'Archive', exact: true }).click();
      await called(`(c) => c.method === 'abort' && c.id === 'active'`);
      await called(`(c) => c.method === 'options' && c.id === 'active' && !!c.options.archivedAt`);
      expect(await state<boolean>(`(i) => i.state().sessions.some((s) => s.id === 'active' && s.archivedAt)`)).toBe(true);
      // The confirmation toast sits over the sidebar's lower rows for 5 s; dismiss it
      // as a user would, or a slow runner's next click lands on it (#1131).
      const toast = page.locator('[data-toast]', { hasText: 'Chat archived.' });
      await toast.click();
      await expect(toast).toHaveCount(0);
    });

    await test.step('archived rows offer Restore chat and Delete forever', async () => {
      await openList();
      const expandArchived = () => page.locator('[data-archived-toggle][aria-expanded=false]').evaluateAll((els) => els.forEach((b) => (b as HTMLElement).click()));
      const rowMenu = async (id: string) => {
        await expandArchived();
        const row = page.locator(`[data-archived-row=${id}]`);
        // The sticky group heading intercepts pointer events at narrow widths;
        // dispatch contextmenu directly (the mascot covered x:40 at #1131).
        await row.evaluate((el) => el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })));
      };
      await rowMenu('project-archived');
      await shot(`archived-menu-${theme}-${width}`);
      await expect(page.locator('[role=menu] [role=menuitem]')).toHaveText(['Restore chat', 'Delete forever']);
      await page.getByRole('menuitem', { name: 'Restore chat' }).click();
      await called(`(c) => c.method === 'options' && c.id === 'project-archived' && c.options.archivedAt === null`);
      await expect(page.locator('[role=menu]')).toHaveCount(0);

      await openList();
      await page.locator('[data-archived-row=archived]').evaluate((el) => (el as HTMLElement).click());
      await expect(page.getByText('Back to active agents')).toBeVisible();
      await openList();
      await rowMenu('archived');
      await page.getByRole('menuitem', { name: 'Delete forever' }).click();
      await expect(page.getByText('Confirm deletion')).toBeVisible();
      expect(await state<boolean>(`(i) => i.calls.some((c) => c.method === 'cleanup' && c.id === 'archived')`), 'asks before deleting').toBe(false);
      await shot(`archived-delete-confirm-${theme}-${width}`);
      await page.getByRole('button', { name: 'Delete', exact: true }).click();
      await called(`(c) => c.method === 'cleanup' && c.id === 'archived'`);
      await expect(page.getByText('Back to active agents')).toHaveCount(0);
    });

    await test.step('a chat window archives from its menu, which also offers Close', async () => {
      // A chat window offers Archive (off the list), Delete, Minimize (kept on
      // the list) and Close (stops the agent, drops the window, keeps the chat
      // listed; #3111, decision 0110). Archive takes it off the list.
      // The project chat restored above is active again; show it on the board.
      await openList();
      await card('Archived project conversation').evaluate((el) => (el as HTMLElement).click());
      const label = 'Archive Archived project conversation';
      const strip = page.locator('[data-pane-title-strip]').filter({ has: page.locator(`button[aria-label="${label}"]`) });
      await expect(strip).toHaveCount(1);
      await strip.evaluate((el) => el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 40 })));
      await expect(page.locator('[role=menu] [role=menuitem]')).toHaveText([/^Archive/, /^Delete/, /^Minimize/, /^Close/]);
      await shot(`window-menu-${theme}-${width}`);
      await page.keyboard.press('Escape');
      await page.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
      await expect(page.locator('[role=menu]')).toHaveCount(0);
      await strip.locator(`button[aria-label="${label}"]`).evaluate((el) => (el as HTMLElement).click());
      await called(`(c) => c.method === 'options' && c.id === 'project-archived' && !!c.options.archivedAt`);
      await expect(strip).toHaveCount(0);
      await expect(page.locator('[data-agent-panel] div[role=button][title*="Archived project conversation"]')).toHaveCount(0);
    });
  });
}
