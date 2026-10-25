import type { FastifyInstance } from "fastify";
import type { Db } from "./db.js";

/**
 * "Send feedback": the quick note from any app's feedback sheet. Unauthenticated,
 * and nothing about the sender is stored, not even the IP (the rate limit keeps
 * counts in memory only). App info comes only when the sender switched it on,
 * and only the fields in `AppInfo`.
 */

export const MAX_FEEDBACK_CHARS = 4000;
const APPS = new Set(["desktop", "web", "ios", "android"]);
const FIELD = /^[A-Za-z0-9 ._+-]+$/;

export interface AppInfo {
  app: string;
  version: string;
  os: string;
  osVersion?: string;
  arch?: string;
}

export type Feedback = { message: string; appInfo: AppInfo | null };

function field(v: unknown, max: number): string | undefined | null {
  if (v === undefined) return undefined;
  if (typeof v !== "string") return null;
  const s = v.trim();
  return s.length > 0 && s.length <= max && FIELD.test(s) ? s : null;
}

function parseAppInfo(v: unknown): AppInfo | null | false {
  if (v === undefined || v === null) return null;
  if (typeof v !== "object" || Array.isArray(v)) return false;
  const o = v as Record<string, unknown>;
  const version = field(o.version, 32);
  const os = field(o.os, 32);
  const osVersion = field(o.osVersion, 32);
  const arch = field(o.arch, 16);
  if (typeof o.app !== "string" || !APPS.has(o.app) || !version || !os || osVersion === null || arch === null) return false;
  // Rebuilt field by field, so an unexpected key never reaches the database.
  return { app: o.app, version, os, ...(osVersion && { osVersion }), ...(arch && { arch }) };
}

export function parseFeedback(body: unknown): { ok: true; value: Feedback } | { ok: false } {
  const o = (body ?? {}) as Record<string, unknown>;
  const message = typeof o.message === "string" ? o.message.trim() : "";
  if (!message || [...message].length > MAX_FEEDBACK_CHARS) return { ok: false };
  const appInfo = parseAppInfo(o.app);
  if (appInfo === false) return { ok: false };
  return { ok: true, value: { message, appInfo } };
}

export function registerFeedback(app: FastifyInstance, db: Db, rateLimit: { max: number; windowMs: number }): void {
  const hits = new Map<string, { count: number; resetAt: number }>();

  // logLevel silent: Fastify's request log would otherwise record the sender's IP.
  app.post("/v1/feedback", { bodyLimit: 32 * 1024, logLevel: "silent" }, async (req, reply) => {
    const now = Date.now();
    const hit = hits.get(req.ip);
    if (hit && hit.resetAt > now) {
      if (++hit.count > rateLimit.max) return reply.code(429).send({ error: "rate-limited" });
    } else {
      hits.set(req.ip, { count: 1, resetAt: now + rateLimit.windowMs });
      if (hits.size > 10_000) for (const [ip, h] of hits) if (h.resetAt <= now) hits.delete(ip);
    }
    const parsed = parseFeedback(req.body);
    if (!parsed.ok) return reply.code(400).send({ error: "bad-feedback" });
    await db.query("insert into feedback (message, app_info) values ($1, $2)", [
      parsed.value.message,
      parsed.value.appInfo && JSON.stringify(parsed.value.appInfo),
    ]);
    return reply.code(202).send({ ok: true });
  });
}
