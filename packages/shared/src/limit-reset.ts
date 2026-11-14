import type { SubscriptionLimits } from './limits.js';

/**
 * When a usage limit that stopped a reply resets, so the chat can offer to
 * carry on by itself then. The time comes from the provider's own message
 * where it names one (Claude Code prints "resets 3pm (Asia/Tokyo)", "resets in
 * 2h 10m", or the older `usage limit reached|<epoch seconds>`), else from a
 * limit window the provider marked as used up.
 */

/** A failure that says a plan's or provider's allowance is spent, not the context window or a reply's output cap. */
export function isUsageLimitFailure(message: string): boolean {
  const m = message.toLowerCase();
  if (/context (window|length)|output (token )?limit|max_tokens|too long/.test(m)) return false;
  return /\b(usage|session|weekly|5-hour|five-hour|rate) limit\b|\blimit (was )?reached\b|\bhit your [\w-]+(?: [\w-]+)? limit\b|\bout of (extra )?usage\b/.test(m);
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

/** The zone, or undefined when the platform does not know it. */
function knownZone(zone: string | undefined): string | undefined {
  if (!zone) return undefined;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return zone;
  } catch {
    return undefined;
  }
}

/** The wall-clock date and time at `t` in `zone` (the computer's own zone when undefined). */
function wallClock(t: number, zone: string | undefined) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric',
  }).formatToParts(new Date(t));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? NaN);
  return { year: get('year'), month: get('month') - 1, day: get('day'), hour: get('hour') % 24, minute: get('minute') };
}

/** The instant a wall-clock time in `zone` names. */
function zonedInstant(year: number, month: number, day: number, hour: number, minute: number, zone: string | undefined): number {
  const asUtc = Date.UTC(year, month, day, hour, minute);
  const offsetAt = (t: number) => {
    const w = wallClock(t, zone);
    return Date.UTC(w.year, w.month, w.day, w.hour, w.minute) - t;
  };
  // Twice, so a time just across a daylight-saving change lands on the right offset.
  const first = asUtc - offsetAt(asUtc);
  return asUtc - offsetAt(first);
}

/** The reset time a limit message names, or null when it names none. */
export function resetTimeInMessage(message: string, now: number): number | null {
  const epoch = /\|\s*(\d{10}|\d{13})\b/.exec(message);
  if (epoch) {
    const n = Number(epoch[1]);
    return n < 1e12 ? n * 1000 : n;
  }
  const relative = /\bresets?\s+in\s+(?:(\d+)\s*d(?:ays?)?\s*)?(?:(\d+)\s*h(?:(?:ou)?rs?)?\s*)?(?:(\d+)\s*m(?:in(?:ute)?s?)?)?/i.exec(message);
  if (relative && (relative[1] || relative[2] || relative[3])) {
    const [d, h, m] = [relative[1], relative[2], relative[3]].map((v) => Number(v ?? 0));
    return now + ((d * 24 + h) * 60 + m) * MINUTE;
  }
  const absolute = new RegExp(
    String.raw`\bresets?\s+(?:at\s+|on\s+)?(?:(${MONTHS.join('|')})[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(?:at\s+)?)?(\d{1,2})(?::(\d{2}))?\s*([ap]\.?m\.?)?(?:\s*\(([^)]+)\))?`,
    'i',
  ).exec(message);
  // A bare number ("resets 3") is too vague: it needs am/pm or minutes.
  if (!absolute || (!absolute[4] && !absolute[5])) return null;
  const [, monthName, dayText, hourText, minuteText, meridiem, zoneText] = absolute;
  let hour = Number(hourText);
  const minute = Number(minuteText ?? 0);
  if (meridiem) {
    if (hour < 1 || hour > 12) return null;
    hour = (hour % 12) + (/^p/i.test(meridiem) ? 12 : 0);
  }
  if (hour > 23 || minute > 59) return null;
  const zone = knownZone(zoneText?.trim());
  const today = wallClock(now, zone);
  if (monthName) {
    const month = MONTHS.indexOf(monthName.slice(0, 3).toLowerCase());
    let at = zonedInstant(today.year, month, Number(dayText), hour, minute, zone);
    // "resets Jan 2" read in late December is next year's.
    if (at < now - 180 * DAY) at = zonedInstant(today.year + 1, month, Number(dayText), hour, minute, zone);
    return at;
  }
  const at = zonedInstant(today.year, today.month, today.day, hour, minute, zone);
  // A time already past today is tomorrow's (a few minutes' grace for a clock running ahead).
  return at < now - 5 * MINUTE ? zonedInstant(today.year, today.month, today.day + 1, hour, minute, zone) : at;
}

/** The latest reset among the windows the provider marked as used up, or null. */
export function resetTimeInLimits(limits: SubscriptionLimits | null | undefined, now: number): number | null {
  const spent = (limits?.windows ?? []).filter((w) => (w.status === 'rate_limited' || w.usedPercent >= 100) && w.resetAt > now);
  return spent.length ? Math.max(...spent.map((w) => w.resetAt)) : null;
}

/**
 * When the limit behind this failure resets, if it is a usage limit and the
 * time is known and still ahead; null otherwise (Retry is all there is).
 */
export function usageLimitResetAt(message: string, limits: SubscriptionLimits | null | undefined, now: number): number | null {
  if (!isUsageLimitFailure(message)) return null;
  const at = resetTimeInMessage(message, now) ?? resetTimeInLimits(limits, now);
  return at !== null && Number.isFinite(at) && at > now ? at : null;
}
