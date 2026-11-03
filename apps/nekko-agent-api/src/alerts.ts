import type { Mailer } from "./confirmations.js";

/** Reports that something broke: a short summary, never a request body or anything about a person. */
export type Alert = (summary: string) => void;

export const ALERT_INTERVAL_MS = 15 * 60 * 1000;

/**
 * Emails `to` through the existing mailer, at most once per `intervalMs`;
 * alerts in between are dropped (the Fly log has every one). Never throws: a
 * failed send is logged and the window still counts, so a broken mailer is
 * not retried on every error.
 */
export function emailAlerter(mailer: Mailer, to: string, intervalMs = ALERT_INTERVAL_MS, now = Date.now): Alert {
  let last = -Infinity;
  return (summary) => {
    const t = now();
    if (t - last < intervalMs) return;
    last = t;
    const text = `${summary}\n\nTime: ${new Date(t).toISOString()}\nMore alerts in the next 15 minutes are not emailed. Read the rest with: fly logs -a nekko-agent-api\nIf personal data may be involved, follow docs/runbooks/privacy-incident.md.`;
    mailer({ to, subject: `Nekko Cloud alert: ${summary.slice(0, 120)}`, text, html: `<pre>${text.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!)}</pre>`, headers: {} })
      .catch((e) => console.error("alert email failed", String(e).slice(0, 200)));
  };
}
