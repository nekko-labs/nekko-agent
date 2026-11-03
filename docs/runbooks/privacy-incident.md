# Privacy incident

What to do when personal data held by Nekko Cloud (`apps/nekko-agent-api`, the
Relay, the website) may have been lost, exposed, changed or reached by someone
who should not have it. One page on purpose: read it top to bottom when it
happens. Spec: [Nekko Cloud data rights](../../spec/platform/nekko-cloud-data-rights.md).

## How it gets noticed

- **The error alert.** The API emails `ALERT_EMAIL` on a 5xx answer or a failed
  background job, at most once per 15 minutes (`src/alerts.ts`). An alert is
  not an incident by itself; it is the prompt to look.
- **Fly logs.** `fly logs -a nekko-agent-api` and `fly logs -a nekko-agent-relay`.
  Request lines carry method, path, status and timing only (no IPs, no query
  strings), so look for unusual paths, a burst of 401/403, or errors.
- **Vendor notices.** A security or incident email from Fly, Neon, Resend,
  Supabase or Vercel, or an entry on their status pages (below).
- **A report from outside.** An email to hello@nekkoagent.com, a GitHub issue,
  or a security researcher.

## Who decides

Philip (philip@nekkolabs.com) decides whether it is a personal data breach,
whether to notify the supervisory authority and whether to tell users. Anyone
else who notices one tells him first, by email and directly, and writes down
the time they noticed.

## The clock

- **72 hours (GDPR Art. 33).** A breach that is likely to put people's rights
  at risk is reported to the supervisory authority within 72 hours of becoming
  aware of it. If not everything is known yet, report what is known and add the
  rest later. Nekko Labs has no establishment in the EU, so there is no lead
  authority: report to the authority of each EU/EEA country where affected
  people live ([EDPB member list](https://www.edpb.europa.eu/about-edpb/about-edpb/members_en)),
  and to the [ICO](https://ico.org.uk/for-organisations/report-a-breach/) for
  people in the UK.
- **Users (Art. 34).** When the risk to people is high (for example account
  emails together with tokens, or anything a person could be harmed by), email
  the affected people without undue delay, in plain words: what happened, what
  data, what we did, what they should do (sign out other devices, change a
  provider key), and who to contact. Not needed when the data was unreadable to
  the attacker (synced data is end-to-end encrypted, tokens are stored as
  hashes), or when the risk has been removed.
- A breach not likely to cause any risk is not reported, but is still recorded.

## Contain first

Revoke what leaked before anything else: rotate the secret with `fly secrets set`
(`DATABASE_URL` through Neon, `RESEND_API_KEY`, `FLY_API_TOKEN`, Supabase keys),
revoke tokens (`update api_tokens set revoked_at = now() where ...`), stop the
affected machines, and redeploy with `fly deploy`.

## What to record

Keep one note per incident in the workspace (date-named), even when nothing is
reported:

- when it happened, when it was noticed, by whom, and how;
- what data and how many people (an estimate is fine), and which systems;
- the likely consequences for those people;
- what was done to contain it and to stop it happening again, with times;
- whether the authority and users were told, when, and the reason if not.

## Vendor contacts

| Vendor | What it holds | Support | Status | Security |
| --- | --- | --- | --- | --- |
| Fly.io | API, Relay, cloud machines, logs | [support](https://fly.io/docs/about/support/) | [status](https://status.flyio.net/) | [security](https://fly.io/security) |
| Neon | The Postgres database | [support](https://neon.com/docs/introduction/support) | [status](https://neonstatus.com/) | [security](https://neon.com/security) |
| Resend | Signup and alert emails | [contact](https://resend.com/contact) | [status](https://resend-status.com/) | [security](https://resend.com/security) |
| Supabase | Sign-in identities | [support](https://supabase.com/support) | [status](https://status.supabase.com/) | [security](https://supabase.com/security) |
| Vercel | The website | [help](https://vercel.com/help) | [status](https://www.vercel-status.com/) | [security](https://vercel.com/security) |

General information, not legal advice.
