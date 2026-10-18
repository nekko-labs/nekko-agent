// Journey: the Agents sidebar. Completed chats, the reader, creating agents and
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
    await page.evaluate('integration.reset()');
    await page.evaluate(`(() => {
      document.documentElement.dataset.theme = '${theme}';
      const completed = integration.records()[0];
      Object.assign(completed, { archivedAt: Date.now(), id: 'completed', title: 'Completed conversation' });
      integration.records().push({ ...completed, id: 'active', title: 'Active conversation', archivedAt: undefined });
      integration.records().push({ ...completed, id: 'project-completed', title: 'Completed project conversation', workspaceId: 'finished-project' });
      const s = integration.state();
      s.settings.workspaces.push({ id: 'finished-project', name: 'Finished project', path: '/synthetic/finished' });
      s.refreshSessions();
    })()`);

    await test.step('completed-only project stays reachable', async () => {
      await openList();
      await page.locator('[data-completed-toggle]').evaluateAll((els) => els.forEach((b) => (b as HTMLElement).click()));
      await expect(page.locator('[data-completed-row=project-completed]')).toBeAttached();
      await shot(`agents-${theme}-${width}`);
    });

    await test.step('a completed chat opens read-only', async () => {
      await page.locator('[data-completed-row=completed]').click();
      await expect(page.getByText('Back to active agents')).toBeVisible();
      await expect(page.locator('[data-wall-composer]')).toHaveCount(0);
      await shot(`completed-${theme}-${width}`);
      await page.getByRole('button', { name: 'Back to active agents', exact: true }).click();
    });

    await test.step('an active card selects its window outside Focus', async () => {
      await openList();
      await card('Active conversation').click();
      expect(await state<string>('(i) => i.state().view')).toBe('command');
      await expect(page.locator('[data-wall-layout]')).toHaveAttribute('data-wall-layout', 'grid');
      await expect(page.locator('[data-wall-selected]')).toHaveAttribute('data-grid-cell', 'chat:active');
    });

    if (width >= 768) await test.step('keyboard resize persists', async () => {
      await page.getByLabel('Resize the agent list').dispatchEvent('keydown', { key: 'ArrowRight' });
      await expect.poll(() => page.evaluate(() => localStorage.getItem('nekko.wsSidebarWidth'))).toBe('272');
    });

    await test.step('create an agent, a media agent and a terminal', async () => {
      await openList();
      const create = async (label: string) => {
        await page.locator('[title="New agent with a terminal"]').dispatchEvent('focusin');
        await page.locator('.create-row', { hasText: label }).first().click();
        expect(await state<string>('(i) => i.state().view'), `${label} stays in Agents`).toBe('command');
      };
      await create('Agent');
      await called(`(c) => c.method === 'create'`);
      await create('Create or Edit Photos and Videos');
      await called(`(c) => c.method === 'options' && c.options.chatType === 'image'`);
      await create('Terminal');
      await called(`(c) => c.method === 'terminal'`);
      expect(await state<number>('(i) => i.state().terminals.length')).toBe(1);
    });

    await test.step('card context menu keeps its actions', async () => {
      await card('Active conversation').click({ button: 'right' });
      await expect(page.getByText('Mark as completed')).toBeVisible();
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

    await test.step('Mark as completed stops and completes the owning chat', async () => {
      await card('Active conversation').click({ button: 'right' });
      await page.getByRole('menuitem', { name: 'Mark as completed', exact: true }).click();
      await called(`(c) => c.method === 'abort' && c.id === 'active'`);
      await called(`(c) => c.method === 'options' && c.id === 'active' && !!c.options.archivedAt`);
      expect(await state<boolean>(`(i) => i.state().sessions.some((s) => s.id === 'active' && s.archivedAt)`)).toBe(true);
    });

    await test.step('completed rows offer Restore chat and Delete forever', async () => {
      await openList();
      const expandCompleted = () => page.locator('[data-completed-toggle][aria-expanded=false]').evaluateAll((els) => els.forEach((b) => (b as HTMLElement).click()));
      const rowMenu = async (id: string) => {
        await expandCompleted();
        const row = page.locator(`[data-completed-row=${id}]`);
        await row.click({ button: 'right', position: { x: 40, y: 10 } });
      };
      await rowMenu('project-completed');
      await shot(`completed-menu-${theme}-${width}`);
      await expect(page.locator('[role=menu] [role=menuitem]')).toHaveText(['Restore chat', 'Delete forever']);
      await page.getByRole('menuitem', { name: 'Restore chat' }).click();
      await called(`(c) => c.method === 'options' && c.id === 'project-completed' && c.options.archivedAt === null`);
      await expect(page.locator('[role=menu]')).toHaveCount(0);

      await openList();
      await page.locator('[data-completed-row=completed]').click();
      await expect(page.getByText('Back to active agents')).toBeVisible();
      await openList();
      await rowMenu('completed');
      await page.getByRole('menuitem', { name: 'Delete forever' }).click();
      await expect(page.getByText('Confirm deletion')).toBeVisible();
      expect(await state<boolean>(`(i) => i.calls.some((c) => c.method === 'cleanup' && c.id === 'completed')`), 'asks before deleting').toBe(false);
      await shot(`completed-delete-confirm-${theme}-${width}`);
      await page.getByRole('button', { name: 'Delete', exact: true }).click();
      await called(`(c) => c.method === 'cleanup' && c.id === 'completed'`);
      await expect(page.getByText('Back to active agents')).toHaveCount(0);
    });

    await test.step('the Chat page does not own the sidebar', async () => {
      await page.evaluate(`integration.route('workspace')`);
      await expect(page.locator('[data-sidebar-group]')).toHaveCount(0);
      await shot(`chat-${theme}-${width}`);
    });
  });
}
