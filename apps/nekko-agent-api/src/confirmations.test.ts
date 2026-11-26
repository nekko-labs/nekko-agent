import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CONFIRM_FROM, CONFIRM_REPLY_TO, CONFIRM_SUBJECT, hashToken, resendMailer, retryConfirmations, type Email, type Mailer } from "./confirmations.js";
import type { Db } from "./db.js";
import { migrate } from "./migrate.js";
import { buildServer } from "./server.js";
import { purgeSignups } from "./retention.js";
import { pgliteDb } from "./test-db.js";

const ORIGIN = "https://nekkoagent.com";
const PUBLIC = "https://api.test";
let db: Db;
let sent: Email[];

beforeEach(async () => {
  db = pgliteDb(new PGlite());
  await migrate(db, undefined, { lock: false });
  sent = [];
});
afterEach(() => db.close());

const capture: Mailer = async (email) => { sent.push(email); };

function server(mailer: Mailer | null = capture) {
  return buildServer({ db, allowedOrigins: [ORIGIN], mailer: mailer ?? undefined, publicUrl: PUBLIC, rateLimit: { max: 100, windowMs: 60_000 } });
}

const signup = (app: ReturnType<typeof server>, email: string) =>
  app.inject({ method: "POST", url: "/v1/signups", headers: { origin: ORIGIN }, payload: { email, name: "Ada <b>" } });

const link = (email: Email, path: string) => {
  const m = email.text.match(new RegExp(`${PUBLIC}${path}\\?token=([\\w-]+)`));
  if (!m) throw new Error(`no ${path} link`);
  return `${path}?token=${m[1]}`;
};

/** Presses the button on a confirm or unsubscribe page: a POST to the link. */
const press = (app: ReturnType<typeof server>, url: string) =>
  app.inject({ method: "POST", url, payload: "", headers: { "content-type": "application/x-www-form-urlencoded" } });

const count = async (table: string) =>
  (await db.query<{ n: number }>(`select count(*)::int as n from ${table}`, [])).rows[0].n;

const status = async (email: string) =>
  (await db.query<{ status: string }>("select status from signups where email = $1", [email])).rows[0].status;

describe("signup confirmation", () => {
  it("emails a pending signup a confirm link and an unsubscribe link", async () => {
    const res = await signup(server(), "ada@example.com");
    expect(res.statusCode).toBe(202);
    expect(await status("ada@example.com")).toBe("pending");
    expect(sent).toHaveLength(1);
    const [email] = sent;
    expect(email.to).toBe("ada@example.com");
    expect(email.subject).toBe(CONFIRM_SUBJECT);
    // The name typed into the form never reaches the email: anyone can sign up any address.
    expect(email.text).not.toContain("Ada");
    expect(email.html).not.toContain("Ada");
    expect(email.text).toContain(`${PUBLIC}/v1/signups/unsubscribe?token=`);
    expect(email.headers["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
    // Only the token's hash is stored.
    const token = link(email, "/v1/signups/confirm").split("=")[1];
    const { rows } = await db.query<{ confirm_token_hash: string }>("select confirm_token_hash from signups", []);
    expect(rows[0].confirm_token_hash).not.toContain(token);
  });

  it("words the confirmation for the app's setup list", async () => {
    const res = await server().inject({ method: "POST", url: "/v1/signups", payload: { email: "ada@example.com", list: "app", source: "/app/setup", marketing: true } });
    expect(res.statusCode).toBe(202);
    expect(sent[0].subject).toBe("Confirm your email for Nekko Agent updates");
    expect(sent[0].text).toContain("Nekko Agent updates");
    expect(sent[0].text).not.toContain("beta");
    expect(sent[0].html).toContain("Confirm my email");
  });

  it("confirms once, on the page's button, then the link is spent", async () => {
    const app = server();
    await signup(app, "ada@example.com");
    const url = link(sent[0], "/v1/signups/confirm");
    // Opening the link (as a mail scanner would) only shows the button.
    const opened = await app.inject({ method: "GET", url });
    expect(opened.statusCode).toBe(200);
    expect(opened.headers["content-type"]).toContain("text/html");
    expect(opened.body).toContain(`<form method="post" action="${url}">`);
    expect(await status("ada@example.com")).toBe("pending");
    const ok = await press(app, url);
    expect(ok.statusCode).toBe(200);
    expect(ok.body).toContain("on the list");
    expect(await status("ada@example.com")).toBe("confirmed");
    expect((await press(app, url)).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url })).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: "/v1/signups/confirm?token=nope" })).statusCode).toBe(400);
  });

  it("escapes the token it echoes into the confirm page", async () => {
    const app = server();
    await signup(app, "ada@example.com");
    await db.query("update signups set confirm_token_hash = $1", [hashToken('x"><script>')]);
    const res = await app.inject({ method: "GET", url: `/v1/signups/confirm?token=${encodeURIComponent('x"><script>')}` });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain("<script>");
  });

  it("refuses a link older than 7 days", async () => {
    const app = server();
    await signup(app, "ada@example.com");
    await db.query("update signups set confirm_expires_at = now() - interval '1 second'", []);
    expect((await app.inject({ method: "GET", url: link(sent[0], "/v1/signups/confirm") })).statusCode).toBe(400);
    expect((await press(app, link(sent[0], "/v1/signups/confirm"))).statusCode).toBe(400);
    expect(await status("ada@example.com")).toBe("pending");
  });

  it("sends at most one email per address per day", async () => {
    const app = server();
    for (let i = 0; i < 4; i++) await signup(app, "ada@example.com");
    expect(sent).toHaveLength(1);
    await db.query("update signups set confirmation_sent_at = now() - interval '25 hours'", []);
    await signup(app, "ADA@example.com");
    expect(sent).toHaveLength(2);
    // The newer email's link replaces the older one.
    expect((await press(app, link(sent[0], "/v1/signups/confirm"))).statusCode).toBe(400);
    expect((await press(app, link(sent[1], "/v1/signups/confirm"))).statusCode).toBe(200);
  });

  it("doesn't email someone already confirmed or invited", async () => {
    const app = server();
    await signup(app, "ada@example.com");
    await press(app, link(sent[0], "/v1/signups/confirm"));
    await db.query("update signups set confirmation_sent_at = null", []);
    await signup(app, "ada@example.com");
    expect(sent).toHaveLength(1);
    expect(await status("ada@example.com")).toBe("confirmed");
  });

  it("unsubscribes on the page's button or RFC 8058 POST, never on just opening the link", async () => {
    const app = server();
    await signup(app, "ada@example.com");
    await signup(app, "bob@example.com");
    const url = link(sent[0], "/v1/signups/unsubscribe");
    const opened = await app.inject({ method: "GET", url });
    expect(opened.statusCode).toBe(200);
    expect(opened.body).toContain(`<form method="post" action="${url}">`);
    expect(await count("signups")).toBe(2);
    const button = await press(app, url);
    expect(button.statusCode).toBe(200);
    expect(button.body).toContain("unsubscribed");
    const oneClick = await app.inject({ method: "POST", url: link(sent[1], "/v1/signups/unsubscribe"), payload: "List-Unsubscribe=One-Click", headers: { "content-type": "application/x-www-form-urlencoded" } });
    expect(oneClick.statusCode).toBe(200);
    // Rows are gone; only the hashed opt-out remains.
    expect(await count("signups")).toBe(0);
    expect(await count("email_suppressions")).toBe(2);
    // The same link again still answers, by GET or POST.
    expect((await app.inject({ method: "GET", url })).statusCode).toBe(200);
    expect((await press(app, url)).statusCode).toBe(200);
    // The confirm link stops working too.
    expect((await press(app, link(sent[0], "/v1/signups/confirm"))).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: "/v1/signups/unsubscribe?token=nope" })).statusCode).toBe(404);
    expect((await press(app, "/v1/signups/unsubscribe?token=nope")).statusCode).toBe(404);
  });

  it("saves the signup and skips the email when there is no Resend key", async () => {
    const res = await signup(server(null), "ada@example.com");
    expect(res.statusCode).toBe(202);
    expect(await status("ada@example.com")).toBe("pending");
    const { rows } = await db.query("select confirmation_sent_at from signups", []);
    expect(rows).toEqual([{ confirmation_sent_at: null }]);
  });

  it("still saves the signup when the email fails, and retries on the next signup", async () => {
    let fail = true;
    const flaky: Mailer = async (e) => { if (fail) throw new Error("down"); sent.push(e); };
    const app = server(flaky);
    expect((await signup(app, "ada@example.com")).statusCode).toBe(202);
    expect(await status("ada@example.com")).toBe("pending");
    const { rows } = await db.query<{ confirmation_failed_at: Date | null }>("select confirmation_failed_at from signups", []);
    expect(rows[0].confirmation_failed_at).not.toBeNull();
    fail = false;
    await signup(app, "ada@example.com");
    expect(sent).toHaveLength(1);
  });

  it("refuses list names other than beta and app", async () => {
    const app = server();
    for (const list of ["a", "b", "waitlist"]) {
      const res = await app.inject({ method: "POST", url: "/v1/signups", payload: { email: "ada@example.com", list } });
      expect(res.statusCode).toBe(400);
    }
    expect(await count("signups")).toBe(0);
    expect(sent).toHaveLength(0);
  });
});

describe("retryConfirmations", () => {
  it("sends to signups whose email failed or was never tried, once", async () => {
    let fail = true;
    const flaky: Mailer = async (e) => { if (fail) throw new Error("down"); sent.push(e); };
    await signup(server(flaky), "failed@example.com");
    await signup(server(null), "untried@example.com");
    expect(sent).toHaveLength(0);
    expect(await retryConfirmations(db, undefined, PUBLIC, () => {})).toBe(0);
    expect(await retryConfirmations(db, flaky, PUBLIC, () => {})).toBe(0);
    fail = false;
    expect(await retryConfirmations(db, flaky, PUBLIC, () => {})).toBe(2);
    expect(sent.map((e) => e.to).sort()).toEqual(["failed@example.com", "untried@example.com"]);
    // Both are now emailed, so the next run sends nothing.
    expect(await retryConfirmations(db, flaky, PUBLIC, () => {})).toBe(0);
    expect(sent).toHaveLength(2);
  });

  it("keeps the first failure time across retries", async () => {
    const down: Mailer = async () => { throw new Error("down"); };
    await signup(server(down), "ada@example.com");
    await db.query("update signups set confirmation_failed_at = now() - interval '10 days'", []);
    await retryConfirmations(db, down, PUBLIC, () => {});
    const { rows } = await db.query<{ old: boolean }>("select confirmation_failed_at < now() - interval '9 days' as old from signups", []);
    expect(rows).toEqual([{ old: true }]);
  });
});

describe("retention", () => {
  it("never emails or stores an address that unsubscribed, even if it signs up again", async () => {
    const app = server();
    await signup(app, "ada@example.com");
    await press(app, link(sent[0], "/v1/signups/unsubscribe"));
    const again = await signup(app, "ADA@example.com ");
    expect(again.statusCode).toBe(202);
    expect(again.json()).toEqual({ ok: true });
    expect(sent).toHaveLength(1);
    expect(await count("signups")).toBe(0);
  });

  it("deletes sign-ups unconfirmed 30 days after their email, and nothing else", async () => {
    const app = server();
    for (const e of ["old@example.com", "new@example.com", "conf@example.com", "inv@example.com"]) await signup(app, e);
    await press(app, link(sent[2], "/v1/signups/confirm"));
    await db.query("update signups set status = 'invited' where email = 'inv@example.com'", []);
    await db.query("update signups set confirmation_sent_at = now() - interval '31 days' where email <> 'new@example.com'", []);
    await db.query("update signups set confirmation_sent_at = now() - interval '29 days' where email = 'new@example.com'", []);
    // Signed up long ago but never emailed (before double opt-in, or no Resend key): kept for the retry job.
    await db.query("insert into signups (email, created_at) values ('legacy@example.com', now() - interval '400 days')", []);
    // Never emailed because sending failed: deleted 30 days after the first failure, not before.
    await db.query("insert into signups (email, confirmation_failed_at) values ('bounce@example.com', now() - interval '31 days'), ('flaky@example.com', now() - interval '29 days')", []);
    expect(await purgeSignups(db)).toEqual({ unconfirmed: 1, undeliverable: 1, suppressed: 0, unsubscribed: 0 });
    const { rows } = await db.query<{ email: string }>("select email from signups order by email", []);
    expect(rows.map((r) => r.email)).toEqual(["conf@example.com", "flaky@example.com", "inv@example.com", "legacy@example.com", "new@example.com"]);
  });

  it("deletes pending rows saved for an address that had unsubscribed", async () => {
    const app = server();
    await signup(app, "ada@example.com");
    await press(app, link(sent[0], "/v1/signups/unsubscribe"));
    // Saved before signups of unsubscribed addresses were refused.
    await db.query("insert into signups (email, list) values ('Ada@Example.com', 'app'), ('bob@example.com', 'beta')", []);
    expect(await purgeSignups(db)).toEqual({ unconfirmed: 0, undeliverable: 0, suppressed: 1, unsubscribed: 0 });
    const { rows } = await db.query<{ email: string }>("select email from signups", []);
    expect(rows).toEqual([{ email: "bob@example.com" }]);
  });

  it("removes rows marked unsubscribed but keeps them suppressed", async () => {
    const app = server();
    await signup(app, "old@example.com");
    await db.query("update signups set status = 'unsubscribed', confirmation_sent_at = null", []);
    expect(await purgeSignups(db)).toEqual({ unconfirmed: 0, undeliverable: 0, suppressed: 0, unsubscribed: 1 });
    await signup(app, "old@example.com");
    expect(sent).toHaveLength(1);
    expect(await count("signups")).toBe(0);
  });

  it("deletes nothing when a run fails partway", async () => {
    await signup(server(), "old@example.com");
    await db.query("update signups set confirmation_sent_at = now() - interval '31 days', status = 'unsubscribed'", []);
    // The second delete fails after the first statements ran.
    const failing: Db = { ...db, transaction: (fn) => db.transaction((tx) => fn({ ...tx, query: async (text, params) => {
      if (text.includes("status = 'pending'")) throw new Error("boom");
      return tx.query(text, params);
    } })) };
    await expect(purgeSignups(failing)).rejects.toThrow("boom");
    expect((await db.query("select count(*)::int as n from signups", [])).rows).toEqual([{ n: 1 }]);
    expect((await db.query("select count(*)::int as n from email_suppressions", [])).rows).toEqual([{ n: 0 }]);
  });
});

describe("resendMailer", () => {
  it("posts to Resend with the sender and reply-to", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fake = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    await resendMailer("re_test", fake)({ to: "a@b.co", subject: "s", html: "h", text: "t", headers: {} });
    expect(calls[0].url).toBe("https://api.resend.com/emails");
    expect((calls[0].init.headers as Record<string, string>).authorization).toBe("Bearer re_test");
    const body = JSON.parse(String(calls[0].init.body));
    expect(body).toMatchObject({ from: CONFIRM_FROM, reply_to: CONFIRM_REPLY_TO, to: ["a@b.co"] });
    expect(CONFIRM_FROM).toContain("hello@mail.nekkoagent.com");
  });

  it("throws on a Resend error", async () => {
    const fake = (async () => new Response("bad", { status: 422 })) as unknown as typeof fetch;
    await expect(resendMailer("k", fake)({ to: "a@b.co", subject: "s", html: "h", text: "t", headers: {} })).rejects.toThrow("422");
  });
});
