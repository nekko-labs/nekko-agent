/** The text sizes Settings offers, in percent. The first and last are the limits. */
export const TEXT_SCALES = [80, 90, 100, 110, 125, 150];

/** The next size up (1) or down (-1), or `from` itself at the limit. A saved size between two steps moves to the nearer one that way. */
export const stepTextScale = (from: number, direction: 1 | -1): number =>
  (direction > 0 ? TEXT_SCALES.find((s) => s > from) : [...TEXT_SCALES].reverse().find((s) => s < from)) ?? from;

/** How much zoom scales `el`. Rects are in zoomed pixels and `scrollTop` is not, so divide a rect distance by this to scroll by it. */
export const zoomOf = (el: HTMLElement): number => el.getBoundingClientRect().height / el.offsetHeight || 1;
