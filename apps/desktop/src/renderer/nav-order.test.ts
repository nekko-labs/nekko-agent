import { describe, expect, it } from 'vitest';
import { moveNav, navOrder, sidebarViewVisible } from './nav-order.js';
describe('navigation ordering', () => {
  it('drops unknown ids, removes duplicates and retains newly added views', () => {
    expect(navOrder(['chat','models','settings'], ['settings','bad','settings'])).toEqual(['settings','chat','models']);
  });
  it('preserves hidden destinations while moving visible ones', () => {
    expect(moveNav(['chat','training','models','settings'], 'settings','chat')).toEqual(['settings','chat','training','models']);
  });
  it('does not mutate input or reorder unknown destinations', () => {
    const order = ['chat','models']; expect(moveNav(order,'missing','models')).toEqual(order); expect(order).toEqual(['chat','models']);
  });
});

describe('optional sidebar shortcuts', () => {
  it('hides Skills and Connectors by default without hiding other views', () => {
    expect(sidebarViewVisible('skills')).toBe(false);
    expect(sidebarViewVisible('connectors', {})).toBe(false);
    expect(sidebarViewVisible('settings')).toBe(true);
  });
  it('opts into each shortcut independently', () => {
    expect(sidebarViewVisible('skills', { skills: true })).toBe(true);
    expect(sidebarViewVisible('connectors', { skills: true })).toBe(false);
    expect(sidebarViewVisible('connectors', { connectors: true })).toBe(true);
  });
});
