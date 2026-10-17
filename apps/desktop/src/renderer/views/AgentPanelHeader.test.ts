import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// WorkspacesView pulls in the whole Agent tab, so these check its source.
const source = readFileSync(new URL('./WorkspacesView.tsx', import.meta.url), 'utf8');
const css = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');
const toolbar = readFileSync(new URL('./CommandCenterView.tsx', import.meta.url), 'utf8');
const controls = readFileSync(new URL('../components/AgentPanelControls.tsx', import.meta.url), 'utf8');

describe('Agents panel header', () => {
  it('hides with a left-panel icon rather than an X, and swaps sides with the curved-arrow icon', () => {
    expect(controls).toContain("aria-label={show ? 'Hide the agent panel' : 'Show the agent panel'}");
    expect(controls).toMatch(/Show the agent panel'\}[\s\S]{0,260}<PanelLeftIcon/);
    expect(controls).toContain('<PanelSwapIcon');
    expect(source).toContain('<AgentPanelControls show orientation={orientation}');
    expect(source).not.toContain('Close the agent panel');
    expect(source).not.toContain('<CloseIcon');
  });
  it('keeps the panel controls where the panel was when it is collapsed, and nowhere in the title bar', () => {
    expect(toolbar).toContain('<AgentPanelControls show={false} orientation={panel.orientation}');
    expect(toolbar).not.toContain("aria-label={panel.show ? 'Hide the agent panel' : 'Show the agent panel'}");
    expect(toolbar).not.toContain('PanelSwapIcon');
  });
  it('draws no outer ring around the Agents tab panel in either orientation', () => {
    expect(source).toContain("className={`panel ${sidebarOnly ? '' : 'panel-ring '}flex");
  });
  it('renders the + in the accent, a size up, with its menu portalled above the wall', () => {
    expect(source).toContain('agent-panel-plus');
    expect(source).toContain('<PlusIcon className="h-[22px] w-[22px]" />');
    expect(css).toContain('.agent-panel-plus { color: var(--accent); }');
    expect(source).toMatch(/newMenuOpen && newMenuPos && createPortal\(/);
    expect(source).toContain('className="card fixed z-[1000] w-64 p-1.5 shadow-lg"');
    expect(source).toContain('document.body,');
  });
  it('opens the view menu from the sliders button and from a right-click on any group header', () => {
    expect(source).toContain('<SlidersIcon className="h-4 w-4" />');
    expect(source).toContain('aria-label="Agent panel view options"');
    expect(source).toMatch(/onContextMenu=\{sidebarOnly \? \(e\) => \{ e\.preventDefault\(\); e\.stopPropagation\(\); setViewMenu\(\{ x: e\.clientX, y: e\.clientY \}\)/);
    expect(source).toContain('<AgentPanelViewMenu x={viewMenu.x} y={viewMenu.y} view={view} onChange={setView} onClose={closeViewMenu} />');
  });
  it('only drags cards into order where that order is what the panel shows', () => {
    expect(source).toContain('draggable={reorderable}');
    expect(source).toContain("draggable={byProject && !!b.ws}");
  });
  it('puts a search button beside the +, in the same accent and size, opening the chat finder', () => {
    expect(source).toContain('<SearchIcon className="h-[22px] w-[22px]" />');
    expect(source).toMatch(/data-chat-finder-toggle[\s\S]{0,400}<ChatFinder[\s\S]{0,400}ref=\{newMenuButtonRef\}/);
    expect(source).toMatch(/className=\{`agent-panel-plus btn btn-ghost px-1\.5 py-1 \$\{finderOpen/);
  });
  it('keeps the composer row to the composer alone in either docking position; adding lives in the toolbar', () => {
    expect(toolbar).toContain("wall.composer.side === 'bottom' && composerRow");
    expect(toolbar).toContain('>{composer}</div>');
    expect(toolbar).not.toMatch(/const composerRow[\s\S]*?addButton[\s\S]*?<ErrorBoundary label="Shared composer"/);
    expect(toolbar).toContain('anchorRef={addButtonRef}');
    expect(toolbar).toContain("wall.composer.side === 'top' && composerRow");
    expect(toolbar).not.toContain('wall-add-arrow');
    expect(css).not.toContain('.wall-add-arrow');
    expect(css).not.toContain('.wall-add-launch');
    expect(css).toContain('.wall-add-bar { display: inline-flex;');
    expect(css).not.toContain('.wall-composer-row { flex-direction: column;');
  });
});
