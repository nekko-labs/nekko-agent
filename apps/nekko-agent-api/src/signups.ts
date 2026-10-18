import type { Db } from "./db.js";

export interface SignupInput {
  email: string;
  name: string | null;
  list: string;
  source: string | null;
  utm: Record<string, string>;
}

export type Parsed = { ok: true; value: SignupInput } | { ok: false; error: string };

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const LIST = /^[a-z0-9][a-z0-9-]{0,39}$/;
const UTM_KEYS = ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content"] as const;

function text(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().replace(/\s+/g, " ");
  return trimmed ? trimmed.slice(0, max) : null;
}

/** Validates a form body. Unknown fields are ignored, never stored. */
export function parseSignup(body: unknown): Parsed {
  if (!body || typeof body !== "object") return { ok: false, error: "Expected a JSON body." };
  const b = body as Record<string, unknown>;
  const email = typeof b.email === "string" ? b.email.trim() : "";
  if (email.length > 320 || !EMAIL.test(email)) return { ok: false, error: "Enter a valid email address." };
  const list = b.list === undefined ? "beta" : b.list;
  if (typeof list !== "string" || !LIST.test(list)) return { ok: false, error: "Unknown list." };
  // A path only: a full URL could carry someone's query string into the table.
  const rawSource = text(b.source, 200);
  const source = rawSource && rawSource.startsWith("/") ? rawSource.split(/[?#]/)[0] : null;
  const utm: Record<string, string> = {};
  const rawUtm = b.utm && typeof b.utm === "object" ? (b.utm as Record<string, unknown>) : {};
  for (const key of UTM_KEYS) {
    const v = text(rawUtm[key], 100);
    if (v) utm[key] = v;
  }
  return { ok: true, value: { email, name: text(b.name, 200), list, source, utm } };
}

/**
 * Records a signup. Signing up twice is not an error: the existing row keeps its
 * status and first-seen source, and picks up a name if it had none. An
 * unsubscribed address that signs up again goes back to pending.
 */
export async function recordSignup(db: Db, input: SignupInput): Promise<{ id: string; created: boolean }> {
  const { rows } = await db.query<{ id: string; created: boolean }>(
    `insert into signups (email, name, list, source, utm)
     values ($1, $2, $3, $4, $5::jsonb)
     on conflict (list, lower(email)) do update set
       name = coalesce(signups.name, excluded.name),
       status = case when signups.status = 'unsubscribed' then 'pending' else signups.status end,
       consented_at = now(),
       updated_at = now()
     returning id, (xmax = 0) as created`,
    [input.email, input.name, input.list, input.source, JSON.stringify(input.utm)],
  );
  return rows[0];
}
