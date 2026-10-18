import { readFileSync } from 'node:fs';
import postcss, { type ChildNode, type Container, type Root, type Rule } from 'postcss';

/**
 * Reads the renderer's stylesheets as parsed rules, so a test asserts which
 * declarations a selector gets rather than how the file happens to be laid out.
 * Reformatting, reordering or splitting a rule does not break these checks;
 * changing what the selector actually gets does.
 */

const cache = new Map<string, Root>();

/** A renderer stylesheet by path relative to `src/renderer` (e.g. `styles.css`, `components/commandWallLayouts.css`). */
export function stylesheet(path: string): Root {
  let root = cache.get(path);
  if (!root) {
    root = postcss.parse(readFileSync(new URL(`../${path}`, import.meta.url), 'utf8'));
    cache.set(path, root);
  }
  return root;
}

const norm = (s: string) => s.replace(/\s+/g, ' ').replace(/'/g, '"').replace(/\s*([>+~,()])\s*/g, '$1').trim();

/** A selector or value written the way `cssRule` reports it (whitespace and quotes normalized). */
export const cssValue = norm;

/** The @media conditions a rule sits inside, outermost first, normalized. */
function mediaOf(node: ChildNode): string[] {
  const out: string[] = [];
  for (let p: Container | undefined = node.parent as Container | undefined; p && p.type !== 'root'; p = p.parent as Container | undefined) {
    if (p.type === 'atrule' && (p as unknown as { name: string }).name === 'media') out.unshift(norm((p as unknown as { params: string }).params));
  }
  return out;
}

export interface RuleQuery {
  /**
   * Only rules inside an @media whose condition contains this text (normalized),
   * e.g. `prefers-reduced-motion: reduce`. Omitted: only rules outside any @media.
   */
  media?: string;
}

/**
 * A rule's selectors with CSS nesting resolved: `.a { & .b {} }` gives `.a .b`,
 * `.a { &:hover {} }` gives `.a:hover`, and a nested selector without `&` is a
 * descendant of its parent.
 */
export function resolvedSelectors(rule: Rule): string[] {
  let parent = rule.parent as Container | undefined;
  while (parent && parent.type !== 'rule' && parent.type !== 'root') parent = parent.parent as Container | undefined;
  if (!parent || parent.type !== 'rule') return rule.selectors.map(norm);
  const outer = resolvedSelectors(parent as Rule);
  return outer.flatMap((o) => rule.selectors.map((s) => norm(s.includes('&') ? s.replaceAll('&', o) : `${o} ${s}`)));
}

/** Every rule that lists `selector` (one entry of its selector list), in source order. */
export function rules(sheet: Root, selector: string, query: RuleQuery = {}): Rule[] {
  const want = norm(selector);
  const media = query.media === undefined ? undefined : norm(query.media);
  const found: Rule[] = [];
  sheet.walkRules((rule) => {
    if (!resolvedSelectors(rule).includes(want)) return;
    const at = mediaOf(rule);
    if (media === undefined ? at.length > 0 : !at.some((m) => m.includes(media))) return;
    found.push(rule);
  });
  return found;
}

/**
 * The declarations `selector` gets, later rules winning, as `property -> value`
 * (with ` !important` appended when present). Custom properties included.
 */
export function cssRule(sheet: Root, selector: string, query: RuleQuery = {}): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rule of rules(sheet, selector, query)) {
    rule.each((node) => {
      // Only the rule's own declarations: nested rules are other selectors.
      if (node.type === 'decl') out[node.prop] = norm(node.value) + (node.important ? ' !important' : '');
    });
  }
  return out;
}

/** Whether any rule's selector matches `pattern` (tested against each normalized selector). */
export function hasSelector(sheet: Root, pattern: RegExp): boolean {
  let hit = false;
  sheet.walkRules((rule) => { if (resolvedSelectors(rule).some((s) => pattern.test(s))) hit = true; });
  return hit;
}

/** Whether `@keyframes name` is defined. */
export function hasKeyframes(sheet: Root, name: string): boolean {
  let hit = false;
  sheet.walkAtRules('keyframes', (at) => { if (at.params.trim() === name) hit = true; });
  return hit;
}
