import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Db } from "./db.js";
import { cleanScreenshot, MAX_SCREENSHOT_BASE64, MAX_SCREENSHOTS, parseScreenshotList } from "./screenshots.js";

/**
 * "Send feedback": the quick note from any app's feedback sheet. Unauthenticated,
 * and nothing about the sender is stored, not even the IP (the rate limit keeps
 * counts in memory only). App info comes only when the sender switched it on,
 * and only the fields in `AppInfo`. Screenshots come only on their own route
 * (`/v1/feedback/screenshots`), so a server that predates them answers 404
 * rather than storing the note and dropping the images.
 */

export const MAX_FEEDBACK_CHARS = 4000;
const APPS = new Set(["desktop", "web", "ios", "android"]);
const FIELD = /^[A-Za-z0-9 ._+-]+$/;
const HOUR = 60 * 60 * 1000;

export interface AppInfo {
  app: string;
  version: string;
  os: string;
  osVersion?: string;
  arch?: string;
}

export type Feedback = { message: string; appInfo: AppInfo | null };

/** Notes with screenshots per IP per window, and how many may upload at once (the machine has 256 MB). */
export interface ScreenshotLimit {
  max: number;
  windowMs: number;
  inFlight: number;
}

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

type Hits = Map<string, { count: number; resetAt: number }>;

/** Counts one more request from `ip`; true when that goes over `max` in the window. */
function over(hits: Hits, ip: string, max: number, windowMs: number): boolean {
  const now = Date.now();
  const hit = hits.get(ip);
  if (hit && hit.resetAt > now) return ++hit.count > max;
  hits.set(ip, { count: 1, resetAt: now + windowMs });
  if (hits.size > 10_000) for (const [key, h] of hits) if (h.resetAt <= now) hits.delete(key);
  return false;
}

async function store(db: Db, note: Feedback, screenshots: { type: string; data: Buffer }[] = []): Promise<void> {
  await db.transaction(async (tx) => {
    const { rows } = await tx.query<{ id: string }>("insert into feedback (message, app_info) values ($1, $2) returning id", [
      note.message,
      note.appInfo && JSON.stringify(note.appInfo),
    ]);
    for (const [i, s] of screenshots.entries()) {
      await tx.query("insert into feedback_screenshots (feedback_id, position, type, data) values ($1, $2, $3, $4)", [rows[0]!.id, i, s.type, s.data]);
    }
  });
}

export function registerFeedback(
  app: FastifyInstance,
  db: Db,
  rateLimit: { max: number; windowMs: number },
  screenshotLimit: ScreenshotLimit = { max: 3, windowMs: HOUR, inFlight: 2 },
): void {
  const hits: Hits = new Map();
  const screenshotHits: Hits = new Map();
  let uploading = 0;
  const counted = new WeakSet<FastifyRequest>();
  const done = async (req: FastifyRequest) => {
    if (counted.delete(req)) uploading--;
  };

  // logLevel silent: Fastify's request log would otherwise record the sender's IP.
  app.post("/v1/feedback", { bodyLimit: 32 * 1024, logLevel: "silent" }, async (req, reply) => {
    if (over(hits, req.ip, rateLimit.max, rateLimit.windowMs)) return reply.code(429).send({ error: "rate-limited" });
    const parsed = parseFeedback(req.body);
    // Screenshots sent here would be dropped while the note is stored; refuse instead.
    if (!parsed.ok || (req.body as Record<string, unknown> | null)?.screenshots !== undefined) {
      return reply.code(400).send({ error: "bad-feedback" });
    }
    await store(db, parsed.value);
    return reply.code(202).send({ ok: true });
  });

  // Up to 3 images of 5 MB, about 20 MB as base64. The limits run before the
  // body is read, so a refused upload costs no memory.
  app.post(
    "/v1/feedback/screenshots",
    {
      bodyLimit: MAX_SCREENSHOTS * MAX_SCREENSHOT_BASE64 + 64 * 1024,
      logLevel: "silent",
      onRequest: async (req, reply) => {
        if (over(hits, req.ip, rateLimit.max, rateLimit.windowMs) || over(screenshotHits, req.ip, screenshotLimit.max, screenshotLimit.windowMs)) {
          return reply.code(429).send({ error: "rate-limited" });
        }
        if (uploading >= screenshotLimit.inFlight) return reply.code(503).send({ error: "busy" });
        uploading++;
        counted.add(req);
      },
      onResponse: done,
      onRequestAbort: done,
    },
    async (req, reply) => {
      const parsed = parseFeedback(req.body);
      const list = parseScreenshotList((req.body as Record<string, unknown> | null)?.screenshots);
      if (!parsed.ok || !list) return reply.code(400).send({ error: "bad-feedback" });
      const cleaned: { type: string; data: Buffer }[] = [];
      for (const [index, s] of list.entries()) {
        const data = await cleanScreenshot(s.type, s.data);
        if (!data) return reply.code(400).send({ error: "bad-screenshot", index });
        cleaned.push({ type: s.type, data });
      }
      await store(db, parsed.value, cleaned);
      return reply.code(202).send({ ok: true, screenshots: cleaned.length });
    },
  );
}
