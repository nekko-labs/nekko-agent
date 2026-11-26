# Analytics rollout

How to read the consented analytics rollout in PostHog project
[686111](https://us.posthog.com/project/686111) without inventing history or
mixing incompatible populations. The live engagement dashboard is
[2406784](https://us.posthog.com/project/686111/dashboard/2406784).

The engine contract is in `crates/nekkod/src/telemetry.rs` and
`spec/platform/opt-in-usage-and-crash-reports.md`. The website contract is in
`apps/website/analytics.js` and
`spec/brand/beta-signups-and-website-analytics.md`.

## Definitions that must not drift

- An **opted-in install** is `events.distinct_id` on engine telemetry. It is the
  random install id created when usage reports are enabled. It is not a person
  or account, and turning reports off and on creates a new one.
- A **user turn** is a `turn_started` event with `actor = 'user'`. New events
  use `actor = 'user'`, `actor = 'automation'`, or `actor = 'subagent'`.
- `subagent = false` does **not** mean a person started the turn. Legacy
  automation also has `subagent = false`. Label historical rows selected that
  way **legacy non-subagent, origin unknown**, never human or user.
- An **active chat** is a distinct `chat_pseudonym` on a user turn. The
  pseudonym is stable only for one chat inside one opted-in install identity.
  Count `(distinct_id, chat_pseudonym)` pairs. Never infer chat counts from
  turn counts, `$session_id`, or `subagent`.
- Incognito turns have no `chat_pseudonym`. They can contribute to user-turn
  metrics, but not chat metrics.
- A **first-observed chat** is the first user turn for a pseudonym seen after
  the rollout boundary. It is not necessarily a newly created chat: an older
  chat first used after rollout looks the same. Name the metric accordingly.
- `local_hour` and `weekday` are captured from the install's local clock at the
  event instant. Use those properties for local-time charts; do not convert the
  UTC event timestamp or infer a time zone.
- Website rollout events are in scope only when both
  `analytics_schema_version = 2` and `analytics_consent = 'accepted'` are on
  the event. Apply both markers to `$pageview`, `cta_click`, and `$web_vitals`.
- Project 686111 uses UTC. SQL timestamp literals therefore parse as UTC, but
  relative ranges are still preferred.
- Keep **Filter out internal and test users** on. This uses the project's test
  account filter and excludes marked team traffic. It does not replace any
  event filters in this runbook.

## Establish the rollout boundaries

Do this before saving any rollout insight. The new properties have no
historical backfill. Run this over a bounded window after deployment:

```sql
SELECT
    minOrNullIf(
        timestamp,
        event = 'turn_started'
            AND properties.actor = 'user'
    ) AS first_user_actor_event,
    minOrNullIf(
        timestamp,
        event = 'turn_started'
            AND notEmpty(toString(properties.chat_pseudonym))
    ) AS first_chat_pseudonym_event,
    minOrNullIf(
        timestamp,
        toInt(properties.analytics_schema_version) = 2
            AND properties.analytics_consent = 'accepted'
    ) AS first_website_v2_event
FROM events
WHERE timestamp >= now() - INTERVAL 90 DAY
  AND timestamp <= now() + INTERVAL 1 DAY
```

Use the later of `first_user_actor_event` and `first_chat_pseudonym_event` as
`<ENGINE_ROLLOUT_UTC>` for chat metrics. Use `first_website_v2_event` as
`<WEBSITE_ROLLOUT_UTC>` for website metrics. Record the exact values in the
saved insight descriptions. If either value is null, that slice has not
arrived and its insight should say **awaiting rollout data**, not zero.

After rollout, verify the property values rather than assuming them:

1. `turn_started.actor` must contain only `user`, `automation`, and `subagent`.
2. `turn_started.chat_pseudonym` must be 64 lowercase hexadecimal characters
   when present.
3. `local_hour` must be 0 through 23 and `weekday` one of `Mon` through `Sun`.
4. Website events at or after the website boundary must carry both consent
   markers.

## Engine engagement recipes

Every query below starts at `<ENGINE_ROLLOUT_UTC>`. Replace that placeholder
with the boundary found above. Keep the upper clock-skew guard.

### Daily active chats and average per active install

This query aggregates per install first. As a result, `sum(chats_for_install)`
is a distinct-chat count and `avg(chats_for_install)` is the requested average
among installs active that day. `user_turns` is included only as a volume check;
it is never used as a chat count.

```sql
WITH install_days AS (
    SELECT
        toStartOfDay(timestamp) AS day,
        distinct_id AS opted_in_install,
        uniq(toString(properties.chat_pseudonym)) AS chats_for_install,
        count() AS user_turns_for_install
    FROM events
    WHERE event = 'turn_started'
      AND timestamp >= toDateTime('<ENGINE_ROLLOUT_UTC>')
      AND timestamp <= now() + INTERVAL 1 DAY
      AND properties.actor = 'user'
      AND notEmpty(toString(properties.chat_pseudonym))
    GROUP BY day, opted_in_install
)
SELECT
    day,
    count() AS active_opted_in_installs,
    sum(chats_for_install) AS active_chats,
    round(avg(chats_for_install), 2) AS average_chats_per_active_install,
    sum(user_turns_for_install) AS user_turns_for_volume_check
FROM install_days
GROUP BY day
ORDER BY day
LIMIT 500
```

Interpret the average as **chats used per active opted-in install that day**.
It does not include opted-out installs, installs with no user turn that day, or
incognito chats.

### First-observed chats by UTC day

This counts each `(install, chat)` pair once. It does not claim the chat was
created on that day.

```sql
WITH first_observed AS (
    SELECT
        distinct_id AS opted_in_install,
        toString(properties.chat_pseudonym) AS chat_pseudonym,
        min(timestamp) AS first_user_turn_at
    FROM events
    WHERE event = 'turn_started'
      AND timestamp >= toDateTime('<ENGINE_ROLLOUT_UTC>')
      AND timestamp <= now() + INTERVAL 1 DAY
      AND properties.actor = 'user'
      AND notEmpty(toString(properties.chat_pseudonym))
    GROUP BY opted_in_install, chat_pseudonym
)
SELECT
    toStartOfDay(first_user_turn_at) AS day,
    count() AS first_observed_chats
FROM first_observed
GROUP BY day
ORDER BY day
LIMIT 500
```

Do not rename this to **new chats** unless a future event records chat creation
explicitly.

### First-observed chats by local weekday and hour

`argMin` takes the local properties from the first user turn for each chat, so
multiple turns do not overweight a chat.

```sql
WITH first_observed AS (
    SELECT
        distinct_id AS opted_in_install,
        toString(properties.chat_pseudonym) AS chat_pseudonym,
        min(timestamp) AS first_user_turn_at,
        argMin(toInt(properties.local_hour), timestamp) AS local_hour,
        argMin(toString(properties.weekday), timestamp) AS local_weekday
    FROM events
    WHERE event = 'turn_started'
      AND timestamp >= toDateTime('<ENGINE_ROLLOUT_UTC>')
      AND timestamp <= now() + INTERVAL 1 DAY
      AND properties.actor = 'user'
      AND notEmpty(toString(properties.chat_pseudonym))
      AND properties.local_hour IS NOT NULL
      AND properties.weekday IS NOT NULL
    GROUP BY opted_in_install, chat_pseudonym
)
SELECT
    local_weekday,
    local_hour,
    count() AS first_observed_chats
FROM first_observed
GROUP BY local_weekday, local_hour
ORDER BY
    multiIf(
        local_weekday = 'Mon', 1,
        local_weekday = 'Tue', 2,
        local_weekday = 'Wed', 3,
        local_weekday = 'Thu', 4,
        local_weekday = 'Fri', 5,
        local_weekday = 'Sat', 6,
        local_weekday = 'Sun', 7,
        8
    ),
    local_hour
LIMIT 200
```

Use a heatmap or table. The weekday is local to each contributing install, so
this is a behavioural distribution, not a single-zone calendar series.

### Usage frequency by active days

This is the SQL equivalent of a non-cumulative daily stickiness chart, but it
counts opted-in install identities explicitly instead of relying on a person
identity.

```sql
WITH install_frequency AS (
    SELECT
        distinct_id AS opted_in_install,
        uniq(toDate(timestamp)) AS active_days
    FROM events
    WHERE event = 'turn_started'
      AND timestamp >= greatest(
          toDateTime('<ENGINE_ROLLOUT_UTC>'),
          now() - INTERVAL 30 DAY
      )
      AND timestamp <= now() + INTERVAL 1 DAY
      AND properties.actor = 'user'
    GROUP BY opted_in_install
)
SELECT
    active_days,
    count() AS opted_in_installs
FROM install_frequency
GROUP BY active_days
ORDER BY active_days
LIMIT 31
```

For a native PostHog Stickiness insight, use `turn_started`, interval **day**,
calculation **non-cumulative**, and event property `actor` exactly `user`.
Name it **User-turn usage frequency**. The SQL above remains the reference when
an exact opted-in-install denominator matters.

### Chat frequency per opted-in install

This distribution counts distinct chats in the selected window, not turns.

```sql
WITH install_frequency AS (
    SELECT
        distinct_id AS opted_in_install,
        uniq(toString(properties.chat_pseudonym)) AS chats_in_window
    FROM events
    WHERE event = 'turn_started'
      AND timestamp >= greatest(
          toDateTime('<ENGINE_ROLLOUT_UTC>'),
          now() - INTERVAL 30 DAY
      )
      AND timestamp <= now() + INTERVAL 1 DAY
      AND properties.actor = 'user'
      AND notEmpty(toString(properties.chat_pseudonym))
    GROUP BY opted_in_install
)
SELECT
    chats_in_window,
    count() AS opted_in_installs
FROM install_frequency
GROUP BY chats_in_window
ORDER BY chats_in_window
LIMIT 500
```

A long tail is expected. Do not cap the input; use the chart display to group or
hide rare high values if needed.

### Historical versus post-rollout turns

Use this only to show the taxonomy transition. Do not join the legacy rows to
post-rollout user rows under one **human** label.

```sql
SELECT
    toStartOfDay(timestamp) AS day,
    countIf(
        properties.actor = 'user'
    ) AS post_rollout_user_turns,
    countIf(
        properties.actor = 'automation'
    ) AS post_rollout_automation_turns,
    countIf(
        properties.actor = 'subagent'
    ) AS post_rollout_subagent_turns,
    countIf(
        properties.actor IS NULL
            AND properties.subagent = false
    ) AS legacy_non_subagent_origin_unknown,
    countIf(
        properties.actor IS NULL
            AND properties.subagent IS NULL
    ) AS legacy_origin_unknown
FROM events
WHERE event = 'turn_started'
  AND timestamp >= now() - INTERVAL 90 DAY
  AND timestamp <= now() + INTERVAL 1 DAY
GROUP BY day
ORDER BY day
LIMIT 500
```

Historical chat counts are unavailable because legacy events have no
`chat_pseudonym`. A turn count cannot backfill them. Do not assume a legacy
non-subagent turn was user-started.

## Website consent recipes

### Consent-marker coverage

Run this from `<WEBSITE_ROLLOUT_UTC>` after deployment. `outside_contract`
should be zero for the listed website events after the boundary. A non-zero
value is a capture-contract problem to investigate, not data to silently mix
into the dashboard.

```sql
SELECT
    event,
    count() AS events_after_boundary,
    countIf(
        toInt(properties.analytics_schema_version) = 2
            AND properties.analytics_consent = 'accepted'
    ) AS accepted_schema_v2,
    countIf(
        toInt(properties.analytics_schema_version) != 2
            OR properties.analytics_schema_version IS NULL
            OR properties.analytics_consent != 'accepted'
            OR properties.analytics_consent IS NULL
    ) AS outside_contract
FROM events
WHERE timestamp >= toDateTime('<WEBSITE_ROLLOUT_UTC>')
  AND timestamp <= now() + INTERVAL 1 DAY
  AND event IN ('$pageview', 'cta_click', '$web_vitals')
GROUP BY event
ORDER BY event
LIMIT 10
```

An absent `$web_vitals` row can be normal immediately after rollout because
those events are emitted only when a metric is ready. Missing markers on an
emitted event are not normal.

### Native bounce rate, consent-scoped

PostHog's native web analytics bounce value is `sessions.$is_bounce`. A native
web session has at least one pageview or screen. Do not approximate bounce by
counting single-page pageviews yourself.

Consent markers live on events, not session rows, so restrict the session
population to session ids that contain a marker-bearing `$pageview` in the
same window:

```sql
SELECT
    toStartOfDay($start_timestamp) AS day,
    uniq(session_id) AS accepted_web_sessions,
    sum($is_bounce) AS bounced_sessions,
    round(avg($is_bounce), 3) AS native_bounce_rate
FROM sessions
WHERE $start_timestamp >= toDateTime('<WEBSITE_ROLLOUT_UTC>')
  AND $start_timestamp <= now() + INTERVAL 1 DAY
  AND ($pageview_count > 0 OR $screen_count > 0)
  AND session_id IN (
      SELECT $session_id AS accepted_session_id
      FROM events
      WHERE event = '$pageview'
        AND timestamp >= toDateTime('<WEBSITE_ROLLOUT_UTC>')
        AND timestamp <= now() + INTERVAL 1 DAY
        AND toInt(properties.analytics_schema_version) = 2
        AND properties.analytics_consent = 'accepted'
      GROUP BY accepted_session_id
  )
GROUP BY day
ORDER BY day
LIMIT 500
```

For a headline value, remove `day` and the final `GROUP BY`/`ORDER BY`. Keep the
web-session eligibility filter, accepted-session subquery, time bounds, and
project test-account filter aligned when comparing this result with the native
Web analytics overview.

### Core Web Vitals p75 with units and sample sizes

One `$web_vitals` event can hold only the metrics ready at that instant. The
sample denominator is therefore different for each metric. Never divide by the
total `$web_vitals` event count or put CLS on the same unit axis as durations.

This query returns one row per metric with the unit and that metric's own
sample count:

```sql
SELECT
    'LCP' AS metric,
    'ms' AS unit,
    count() AS samples,
    round(
        quantile(0.75)(toFloat(properties.$web_vitals_LCP_value)),
        0
    ) AS p75
FROM events
WHERE event = '$web_vitals'
  AND timestamp >= greatest(
      toDateTime('<WEBSITE_ROLLOUT_UTC>'),
      now() - INTERVAL 7 DAY
  )
  AND timestamp <= now() + INTERVAL 1 DAY
  AND toInt(properties.analytics_schema_version) = 2
  AND properties.analytics_consent = 'accepted'
  AND properties.$web_vitals_LCP_value IS NOT NULL

UNION ALL

SELECT
    'INP' AS metric,
    'ms' AS unit,
    count() AS samples,
    round(
        quantile(0.75)(toFloat(properties.$web_vitals_INP_value)),
        0
    ) AS p75
FROM events
WHERE event = '$web_vitals'
  AND timestamp >= greatest(
      toDateTime('<WEBSITE_ROLLOUT_UTC>'),
      now() - INTERVAL 7 DAY
  )
  AND timestamp <= now() + INTERVAL 1 DAY
  AND toInt(properties.analytics_schema_version) = 2
  AND properties.analytics_consent = 'accepted'
  AND properties.$web_vitals_INP_value IS NOT NULL

UNION ALL

SELECT
    'CLS' AS metric,
    'score' AS unit,
    count() AS samples,
    round(
        quantile(0.75)(toFloat(properties.$web_vitals_CLS_value)),
        3
    ) AS p75
FROM events
WHERE event = '$web_vitals'
  AND timestamp >= greatest(
      toDateTime('<WEBSITE_ROLLOUT_UTC>'),
      now() - INTERVAL 7 DAY
  )
  AND timestamp <= now() + INTERVAL 1 DAY
  AND toInt(properties.analytics_schema_version) = 2
  AND properties.analytics_consent = 'accepted'
  AND properties.$web_vitals_CLS_value IS NOT NULL

UNION ALL

SELECT
    'FCP' AS metric,
    'ms' AS unit,
    count() AS samples,
    round(
        quantile(0.75)(toFloat(properties.$web_vitals_FCP_value)),
        0
    ) AS p75
FROM events
WHERE event = '$web_vitals'
  AND timestamp >= greatest(
      toDateTime('<WEBSITE_ROLLOUT_UTC>'),
      now() - INTERVAL 7 DAY
  )
  AND timestamp <= now() + INTERVAL 1 DAY
  AND toInt(properties.analytics_schema_version) = 2
  AND properties.analytics_consent = 'accepted'
  AND properties.$web_vitals_FCP_value IS NOT NULL

ORDER BY metric
```

Use separate charts or axes for milliseconds and CLS score. The standard p75
bands are:

| Metric | Unit | Good | Needs improvement | Poor |
| --- | --- | ---: | ---: | ---: |
| LCP | ms | at most 2,500 | over 2,500 through 4,000 | over 4,000 |
| INP | ms | at most 200 | over 200 through 500 | over 500 |
| CLS | score | at most 0.1 | over 0.1 through 0.25 | over 0.25 |
| FCP | ms | at most 1,800 | over 1,800 through 3,000 | over 3,000 |

Always show `samples` beside p75. Treat a low-volume percentile as directional.
For a stable page-level weekly p75, aim for roughly 1,000 samples; for a recent
24-hour regression comparison, aim for roughly 200 samples in the recent side
and 1,000 in its prior baseline. Filter each property separately so one metric's
missing samples never enter another metric's denominator.

When grouping by page, sanitize captured host/path values before displaying
them because browser telemetry is untrusted:

```sql
substring(
    replaceRegexpAll(properties.$host, '[^0-9A-Za-z.:-]', ''),
    1,
    100
) AS host,
substring(
    replaceRegexpAll(
        replaceRegexpAll(properties.$pathname, '[0-9]+', ':id'),
        '[^0-9A-Za-z/_:.-]',
        ''
    ),
    1,
    200
) AS path
```

## Dashboard maintenance

For dashboard
[2406784](https://us.posthog.com/project/686111/dashboard/2406784):

- Post-rollout user engagement tiles must filter `actor = 'user'`, not
  `subagent = false`.
- Use **user** in post-rollout names and descriptions. Reserve **legacy
  non-subagent, origin unknown** for rows with no `actor` and
  `subagent = false`.
- A mixed historical model-attribution tile may include both populations only
  when the title, labels, and description keep them separate. Never label the
  legacy population human.
- A chat tile must use `chat_pseudonym`; a turn tile must say turn. Never rename
  one as the other.
- Keep internal/test-account filtering enabled on every saved insight.
- Until the first rollout events arrive, an actor-filtered tile is correctly
  empty. Do not weaken the filter to make it display historical data.

After editing a tile, reread its saved query and run it. Check the name,
description, complete filter definition, date boundary, and empty-versus-zero
state.

## Synthetic math fixture

The query math was checked locally without sending production events. The
fixture includes two user turns in one chat, multiple chats per install, a chat
active on both days, automation with `subagent = false`, a subagent, and
different Web Vitals sample counts.

Expected engagement results:

| UTC day | User turns (QA only) | Active installs | Active chats | Average chats / active install | First-observed chats |
| --- | ---: | ---: | ---: | ---: | ---: |
| 2026-11-26 | 5 | 2 | 4 | 2.000 | 4 |
| 2026-11-27 | 4 | 3 | 4 | 1.333 | 2 |

Expected frequency buckets:

- active days per install: one install at 1 day, two installs at 2 days;
- chats per install: one install each at 1, 2, and 3 chats;
- a naive `subagent = false` selection contains one more row than
  `actor = 'user'` because it includes automation.

Expected Web Vitals output:

| Metric | Unit | p75 | Samples |
| --- | --- | ---: | ---: |
| LCP | ms | 3,000 | 4 |
| INP | ms | 400 | 2 |
| CLS | score | 0.2 | 3 |
| FCP | ms | 2,000 | 4 |

The check uses only Python's standard library. Re-run it from any checkout:

```bash
python3 - <<'PY'
from collections import Counter, defaultdict
from datetime import datetime

rows = [
    ('2026-11-26T09:00:00', 'A', 'a1', 'user', False),
    ('2026-11-26T09:05:00', 'A', 'a1', 'user', False),
    ('2026-11-26T10:00:00', 'A', 'a2', 'user', False),
    ('2026-11-26T09:30:00', 'B', 'b1', 'user', False),
    ('2026-11-26T23:00:00', 'B', 'b2', 'user', False),
    ('2026-11-26T11:00:00', 'A', 'auto1', 'automation', False),
    ('2026-11-26T12:00:00', 'A', 'sub1', 'subagent', True),
    ('2026-11-27T10:00:00', 'A', 'a1', 'user', False),
    ('2026-11-27T10:10:00', 'A', 'a3', 'user', False),
    ('2026-11-27T00:05:00', 'B', 'b2', 'user', False),
    ('2026-11-27T00:10:00', 'C', 'c1', 'user', False),
]
rows = [
    {
        'at': datetime.fromisoformat(at),
        'install': install,
        'chat': chat,
        'actor': actor,
        'subagent': subagent,
    }
    for at, install, chat, actor, subagent in rows
]
users = [row for row in rows if row['actor'] == 'user']
assert len([row for row in rows if not row['subagent']]) == len(users) + 1

daily = defaultdict(lambda: {'turns': 0, 'installs': set(), 'chats': set()})
first = {}
install_days = defaultdict(set)
install_chats = defaultdict(set)
for row in users:
    day = row['at'].date().isoformat()
    pair = (row['install'], row['chat'])
    daily[day]['turns'] += 1
    daily[day]['installs'].add(row['install'])
    daily[day]['chats'].add(pair)
    install_days[row['install']].add(day)
    install_chats[row['install']].add(row['chat'])
    first[pair] = min(first.get(pair, row['at']), row['at'])

assert (
    daily['2026-11-26']['turns'],
    len(daily['2026-11-26']['installs']),
    len(daily['2026-11-26']['chats']),
) == (5, 2, 4)
assert (
    daily['2026-11-27']['turns'],
    len(daily['2026-11-27']['installs']),
    len(daily['2026-11-27']['chats']),
) == (4, 3, 4)
assert len(daily['2026-11-26']['chats']) / len(daily['2026-11-26']['installs']) == 2
assert abs(
    len(daily['2026-11-27']['chats']) / len(daily['2026-11-27']['installs'])
    - 4 / 3
) < 1e-9
assert Counter(at.date().isoformat() for at in first.values()) == {
    '2026-11-26': 4,
    '2026-11-27': 2,
}
assert Counter(map(len, install_days.values())) == {1: 1, 2: 2}
assert Counter(map(len, install_chats.values())) == {1: 1, 2: 1, 3: 1}

vitals = {
    ('LCP', 'ms'): [1000, 1000, 3000, 3000],
    ('INP', 'ms'): [400, 400],
    ('CLS', 'score'): [0.2, 0.2, 0.2],
    ('FCP', 'ms'): [800, 800, 2000, 2000],
}
expected = {'LCP': 3000, 'INP': 400, 'CLS': 0.2, 'FCP': 2000}
for (metric, _unit), values in vitals.items():
    values.sort()
    nearest_rank = values[max(0, (3 * len(values) + 3) // 4 - 1)]
    assert nearest_rank == expected[metric]

print('analytics rollout fixture: PASS')
PY
```

This fixture validates aggregation math, not live ingestion or HogQL parser
compatibility. Live schema discovery and a post-rollout insight run are still
required before treating a tile as populated.
