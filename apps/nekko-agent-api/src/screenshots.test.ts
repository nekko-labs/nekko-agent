import { PGlite } from "@electric-sql/pglite";
import { crc32, deflateSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "./db.js";
import { migrate } from "./migrate.js";
import { purgeFeedbackScreenshots } from "./retention.js";
import { cleanScreenshot, MAX_SCREENSHOT_BYTES, parseScreenshotList } from "./screenshots.js";
import { buildServer } from "./server.js";
import { pgliteDb } from "./test-db.js";

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** A real 2x2 RGB PNG, with a text chunk and an eXIf chunk that must not be stored. */
function png({ rows = 2, extra = [] as Buffer[] } = {}): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(2, 0);
  ihdr.writeUInt32BE(2, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const pixels = Buffer.alloc(rows * 7, 0x80);
  for (let r = 0; r < rows; r++) pixels[r * 7] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("tEXt", Buffer.from("Author\0Ada Lovelace", "latin1")),
    chunk("eXIf", Buffer.from("GPS 35.68N 139.76E", "latin1")),
    chunk("IDAT", deflateSync(pixels)),
    ...extra,
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function segment(marker: number, body: Buffer): Buffer {
  const head = Buffer.from([0xff, marker, 0, 0]);
  head.writeUInt16BE(body.length + 2, 2);
  return Buffer.concat([head, body]);
}

/** A structurally whole 1x1 JPEG with EXIF, a comment, and a phone's extra bytes after EOI. */
function jpeg(): Buffer {
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    segment(0xe0, Buffer.from("JFIF\0\x01\x01\0\0\x01\0\x01\0\0", "latin1")),
    segment(0xe1, Buffer.from("Exif\0\0GPS 35.68N 139.76E", "latin1")),
    segment(0xfe, Buffer.from("Ada's phone", "latin1")),
    segment(0xdb, Buffer.concat([Buffer.from([0]), Buffer.alloc(64, 1)])),
    segment(0xc0, Buffer.from([8, 0, 1, 0, 1, 1, 1, 0x11, 0])),
    segment(0xda, Buffer.from([1, 1, 0, 0, 63, 0])),
    Buffer.from([0x12, 0x34, 0xff, 0x00, 0x56]),
    Buffer.from([0xff, 0xd9]),
    Buffer.from("MotionPhoto_Data trailing video"),
  ]);
}

const has = (b: Buffer, text: string) => b.includes(Buffer.from(text, "latin1"));

describe("cleanScreenshot", () => {
  it("keeps a real PNG and takes out its text and EXIF", async () => {
    const out = await cleanScreenshot("image/png", png());
    expect(out).not.toBeNull();
    expect(has(out!, "Ada Lovelace") || has(out!, "GPS")).toBe(false);
    expect(has(out!, "IDAT") && has(out!, "IEND")).toBe(true);
    // What is stored is itself a valid PNG.
    expect(await cleanScreenshot("image/png", out!)).toEqual(out);
  });

  it("refuses a PNG whose header is fine but whose contents are not", async () => {
    const good = png();
    expect(await cleanScreenshot("image/png", good.subarray(0, good.length - 12))).toBeNull(); // no IEND
    const flipped = Buffer.from(good);
    flipped[flipped.indexOf("IDAT") + 6]! ^= 0xff; // CRC no longer matches
    expect(await cleanScreenshot("image/png", flipped)).toBeNull();
    expect(await cleanScreenshot("image/png", png({ rows: 1 }))).toBeNull(); // one row short of IHDR's height
    expect(await cleanScreenshot("image/png", Buffer.concat([good, Buffer.from("x")]))).toBeNull();
    const head = good.subarray(0, 33);
    expect(await cleanScreenshot("image/png", Buffer.concat([head, Buffer.from("not really a picture at all")]))).toBeNull();
  });

  it("keeps a JPEG's picture and drops EXIF, comments and what follows EOI", async () => {
    const out = await cleanScreenshot("image/jpeg", jpeg());
    expect(out).not.toBeNull();
    expect(has(out!, "GPS") || has(out!, "Ada") || has(out!, "MotionPhoto")).toBe(false);
    expect(has(out!, "JFIF")).toBe(true);
    expect(out!.subarray(-2)).toEqual(Buffer.from([0xff, 0xd9]));
    expect(await cleanScreenshot("image/jpeg", out!)).toEqual(out);
  });

  it("refuses a JPEG with only a header, or cut short", async () => {
    const good = jpeg();
    expect(await cleanScreenshot("image/jpeg", Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]))).toBeNull();
    expect(await cleanScreenshot("image/jpeg", good.subarray(0, good.indexOf(Buffer.from([0xff, 0xd9]))))).toBeNull();
    expect(await cleanScreenshot("image/jpeg", Buffer.concat([good.subarray(0, 4), Buffer.from("random bytes here")]))).toBeNull();
  });

  it("refuses an image sent as the other type", async () => {
    expect(await cleanScreenshot("image/jpeg", png())).toBeNull();
    expect(await cleanScreenshot("image/png", jpeg())).toBeNull();
  });
});

describe("parseScreenshotList", () => {
  const one = { name: "Screen Shot of Ada's desktop.png", type: "image/png", data: png().toString("base64") };

  it("takes 1 to 3 entries and drops the file name", () => {
    const list = parseScreenshotList([one]);
    expect(list).not.toBe(false);
    expect(Object.keys((list as object[])[0]!)).toEqual(["type", "data"]);
    expect(parseScreenshotList([one, one, one])).not.toBe(false);
    expect(parseScreenshotList([])).toBe(false);
    expect(parseScreenshotList([one, one, one, one])).toBe(false);
  });

  it("refuses other types, bad base64 and files over 5 MB", () => {
    expect(parseScreenshotList([{ ...one, type: "image/gif" }])).toBe(false);
    expect(parseScreenshotList([{ ...one, data: "not base64!" }])).toBe(false);
    expect(parseScreenshotList([{ ...one, data: Buffer.alloc(MAX_SCREENSHOT_BYTES + 1).toString("base64") }])).toBe(false);
    expect(parseScreenshotList([{ ...one, data: Buffer.alloc(MAX_SCREENSHOT_BYTES).toString("base64") }])).not.toBe(false);
    expect(parseScreenshotList("x")).toBe(false);
    expect(parseScreenshotList([null])).toBe(false);
  });
});

describe("POST /v1/feedback/screenshots", () => {
  let db: Db;
  beforeEach(async () => {
    db = pgliteDb(new PGlite());
    await migrate(db, undefined, { lock: false });
  });
  afterEach(() => db.close());

  const shot = (b: Buffer, type = "image/png") => ({ name: "shot.png", type, data: b.toString("base64") });
  const post = (app: ReturnType<typeof buildServer>, url: string, payload: unknown) =>
    app.inject({ method: "POST", url, payload: payload as object });

  it("stores the note and its cleaned screenshots, in order, without names", async () => {
    const app = buildServer({ db, allowedOrigins: [] });
    const res = await post(app, "/v1/feedback/screenshots", { message: "Needs improvement: x", screenshots: [shot(png()), shot(jpeg(), "image/jpeg")] });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ ok: true, screenshots: 2 });
    const { rows } = await db.query<{ message: string; position: number; type: string; data: Uint8Array }>(
      "select f.message, s.position, s.type, s.data from feedback f join feedback_screenshots s on s.feedback_id = f.id order by s.position",
      [],
    );
    expect(rows.map((r) => [r.message, r.position, r.type])).toEqual([["Needs improvement: x", 0, "image/png"], ["Needs improvement: x", 1, "image/jpeg"]]);
    for (const r of rows) expect(has(Buffer.from(r.data), "GPS")).toBe(false);
  });

  it("refuses a screenshot that isn't a real image, and stores nothing", async () => {
    const app = buildServer({ db, allowedOrigins: [] });
    const fake = Buffer.concat([png().subarray(0, 33), Buffer.from("corrupt")]);
    const res = await post(app, "/v1/feedback/screenshots", { message: "x", screenshots: [shot(png()), shot(fake)] });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "bad-screenshot", index: 1 });
    expect((await db.query("select 1 from feedback", [])).rows).toHaveLength(0);
  });

  it("refuses screenshots on the text-only route rather than dropping them", async () => {
    const res = await post(buildServer({ db, allowedOrigins: [] }), "/v1/feedback", { message: "x", screenshots: [shot(png())] });
    expect(res.statusCode).toBe(400);
    expect((await db.query("select 1 from feedback", [])).rows).toHaveLength(0);
  });

  it("limits notes with screenshots per IP", async () => {
    const app = buildServer({ db, allowedOrigins: [], feedbackScreenshotLimit: { max: 1, windowMs: 60_000, inFlight: 2 } });
    expect((await post(app, "/v1/feedback/screenshots", { message: "1", screenshots: [shot(png())] })).statusCode).toBe(202);
    expect((await post(app, "/v1/feedback/screenshots", { message: "2", screenshots: [shot(png())] })).statusCode).toBe(429);
    // A text note still goes through.
    expect((await post(app, "/v1/feedback", { message: "3" })).statusCode).toBe(202);
  });

  it("deletes screenshots after 90 days and keeps the note", async () => {
    const app = buildServer({ db, allowedOrigins: [] });
    await post(app, "/v1/feedback/screenshots", { message: "old", screenshots: [shot(png())] });
    await post(app, "/v1/feedback/screenshots", { message: "new", screenshots: [shot(png())] });
    await db.query("update feedback set received_on = current_date - 91 where message = $1", ["old"]);
    expect(await purgeFeedbackScreenshots(db)).toBe(1);
    const { rows } = await db.query<{ message: string; n: number }>(
      "select f.message, count(s.position)::int as n from feedback f left join feedback_screenshots s on s.feedback_id = f.id group by f.message order by f.message",
      [],
    );
    expect(rows).toEqual([{ message: "new", n: 1 }, { message: "old", n: 0 }]);
  });
});
