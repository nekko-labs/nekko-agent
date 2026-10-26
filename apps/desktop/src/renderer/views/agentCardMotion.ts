/**
 * Cards that change group (an agent finishing moves from Working to Done)
 * glide there along a short arc that bows out to the right, rather than
 * jumping, so the eye can follow which agent moved.
 *
 * Each group's card list clips its overflow (its fold animation needs that),
 * so the card itself cannot travel outside it. A copy of the card flies over
 * the panel on a fixed layer instead, and the real card stays hidden in its new
 * place until the copy lands on it.
 */

export const CARD_ATTR = 'data-agent-card';
const GROUP_ATTR = 'data-agent-group';
const FLY_MS = 720;

export type CardSpot = { group: string; rect: DOMRect };

/** Copies in flight, by card key, so a card that moves again starts from where its copy is. */
const flying = new Map<string, { ghost: HTMLElement; card: HTMLElement; anim: Animation }>();

/** Where each card in the list is now, and which group it is in. */
export function measureCards(list: HTMLElement | null): Map<string, CardSpot> {
  const spots = new Map<string, CardSpot>();
  for (const card of list?.querySelectorAll<HTMLElement>(`[${CARD_ATTR}]`) ?? []) {
    const key = card.getAttribute(CARD_ATTR)!;
    const group = card.closest(`[${GROUP_ATTR}]`)?.getAttribute(GROUP_ATTR) ?? '';
    spots.set(key, { group, rect: (flying.get(key)?.ghost ?? card).getBoundingClientRect() });
  }
  return spots;
}

/**
 * The flight from one place to the next as transforms on a quadratic curve
 * whose control point sits beside the midpoint, `bow` px to the right, so the
 * path's widest point is half that. Sampled evenly; the animation's easing
 * sets the pace along it.
 */
export function arcKeyframes(dx: number, dy: number, bow: number, steps = 16): Keyframe[] {
  const cx = dx / 2 + bow;
  const cy = dy / 2;
  return Array.from({ length: steps + 1 }, (_, i) => {
    const t = i / steps;
    const x = 2 * (1 - t) * t * cx + t * t * dx;
    const y = 2 * (1 - t) * t * cy + t * t * dy;
    return { transform: `translate(${x.toFixed(2)}px, ${y.toFixed(2)}px)` };
  });
}

/** Fly every card whose group changed since `before` from its old place to its new one. */
export function flyMovedCards(list: HTMLElement | null, before: Map<string, CardSpot>): void {
  if (!list || typeof window.matchMedia !== 'function' || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  for (const card of list.querySelectorAll<HTMLElement>(`[${CARD_ATTR}]`)) {
    const key = card.getAttribute(CARD_ATTR)!;
    const was = before.get(key);
    const group = card.closest(`[${GROUP_ATTR}]`)?.getAttribute(GROUP_ATTR) ?? '';
    if (!was || was.group === group) continue;
    const to = card.getBoundingClientRect();
    // A folded group has nowhere to land, and a folded one had nothing to leave.
    if (!to.height || !was.rect.height) continue;
    const previous = flying.get(key);
    if (previous) { previous.anim.cancel(); previous.ghost.remove(); }

    const ghost = card.cloneNode(true) as HTMLElement;
    ghost.removeAttribute(CARD_ATTR);
    ghost.setAttribute('aria-hidden', 'true');
    ghost.inert = true;
    Object.assign(ghost.style, {
      position: 'fixed', left: `${was.rect.left}px`, top: `${was.rect.top}px`, width: `${was.rect.width}px`,
      margin: '0', zIndex: '60', pointerEvents: 'none', willChange: 'transform',
    });
    document.body.appendChild(ghost);
    card.style.visibility = 'hidden';

    const dx = to.left - was.rect.left;
    const dy = to.top - was.rect.top;
    // Longer trips bow further, within reason.
    const bow = Math.min(72, 24 + Math.abs(dy) * 0.2);
    const anim = ghost.animate(arcKeyframes(dx, dy, bow), { duration: FLY_MS, easing: 'cubic-bezier(0.45, 0, 0.2, 1)', fill: 'forwards' });
    const land = () => {
      if (flying.get(key)?.anim !== anim) return;
      flying.delete(key);
      ghost.remove();
      card.style.visibility = '';
    };
    flying.set(key, { ghost, card, anim });
    anim.onfinish = land;
    anim.oncancel = land;
  }
}
