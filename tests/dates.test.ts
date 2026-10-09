// R12 — calendar dates and audit instants round-trip correctly across a
// timezone change and across both DST transitions.
import { test } from "node:test";
import assert from "node:assert/strict";
import { withUser } from "../db/client.ts";
import { todayFor } from "../db/recurrence.ts";
import { makeTask, makeUser, runtimePool, superPool } from "./helpers.ts";

test("R12: a `date` deadline is stable across a session timezone change", async () => {
  const u = await makeUser();
  const t = await makeTask(u.id, { deadline: "2026-10-09" });

  const read = async (tz: string): Promise<string> =>
    withUser(u.id, async (c) => {
      await c.query(`SET LOCAL TIME ZONE '${tz}'`);
      const { rows } = await c.query<{ d: string }>(
        "SELECT to_char(deadline,'YYYY-MM-DD') AS d FROM tasks WHERE id = $1", [t]);
      return rows[0]!.d;
    }, runtimePool);

  assert.equal(await read("America/Edmonton"), "2026-10-09");
  assert.equal(await read("Pacific/Auckland"), "2026-10-09",
    "a calendar date must not move when the reader's timezone changes");
});

test("R12: the local-midnight timestamptz alternative DOES shift a day — why `date` is used", async () => {
  // Store "9 October, local midnight" for an Auckland user as a timestamptz,
  // which is 2026-10-08 11:00 UTC, then read the calendar date in Edmonton.
  // This is the off-by-one-day bug the date-based model exists to avoid.
  const { rows } = await superPool.query<{
    as_timestamptz: string; as_date: string;
  }>(`
    WITH stored AS (
      SELECT timestamptz '2026-10-09 00:00:00 Pacific/Auckland' AS ts,
             date        '2026-10-09'                          AS d
    )
    SELECT to_char((ts AT TIME ZONE 'America/Edmonton')::date,'YYYY-MM-DD') AS as_timestamptz,
           to_char(d,'YYYY-MM-DD')                                         AS as_date
      FROM stored`);

  assert.equal(rows[0]!.as_timestamptz, "2026-10-08",
    "a local-midnight timestamptz read from another zone lands on the WRONG day");
  assert.equal(rows[0]!.as_date, "2026-10-09",
    "the same calendar date stored as `date` is unaffected");
  assert.notEqual(rows[0]!.as_timestamptz, rows[0]!.as_date,
    "the two models genuinely disagree — this is the bug `date` prevents");
});

test("R12: 'today' is derived server-side from the user's stored IANA zone", async () => {
  const edmonton = await makeUser("America/Edmonton");
  const auckland = await makeUser("Pacific/Auckland");

  const [dayHere, dayThere] = await Promise.all([
    withUser(edmonton.id, (c) => todayFor(c, edmonton.id), runtimePool),
    withUser(auckland.id, (c) => todayFor(c, auckland.id), runtimePool),
  ]);

  assert.match(dayHere, /^\d{4}-\d{2}-\d{2}$/);
  assert.match(dayThere, /^\d{4}-\d{2}-\d{2}$/);
  // Auckland is always at or ahead of Edmonton's calendar date.
  assert.ok(dayThere >= dayHere, `${dayThere} should be >= ${dayHere}`);
});

test("R12: a fixed UTC offset is rejected as a timezone", async () => {
  await assert.rejects(() => makeUser("+05:30"), /violates check constraint|unknown IANA timezone/);
  await assert.rejects(() => makeUser("Mars/Olympus"), /unknown IANA timezone/);
});

test("R12: both DST transitions yield exactly one calendar date per day", async () => {
  const { rows } = await superPool.query<{ spring: string; fall: string; mondays: string }>(`
    SELECT
      (SELECT count(DISTINCT d)::text FROM generate_series(
         timestamptz '2027-03-14 00:00 America/Edmonton',
         timestamptz '2027-03-14 23:59 America/Edmonton', interval '1 hour') g(ts),
         LATERAL (SELECT (ts AT TIME ZONE 'America/Edmonton')::date AS d) x) AS spring,
      (SELECT count(DISTINCT d)::text FROM generate_series(
         timestamptz '2027-11-07 00:00 America/Edmonton',
         timestamptz '2027-11-07 23:59 America/Edmonton', interval '1 hour') g(ts),
         LATERAL (SELECT (ts AT TIME ZONE 'America/Edmonton')::date AS d) x) AS fall,
      (SELECT count(*)::text FROM generate_series(
         date '2027-03-08', date '2027-03-29', interval '1 week') g(d)) AS mondays`);

  assert.equal(rows[0]!.spring, "1", "spring-forward day is exactly one calendar date");
  assert.equal(rows[0]!.fall, "1", "fall-back day is exactly one calendar date");
  assert.equal(rows[0]!.mondays, "4",
    "a weekly Monday rule across the spring-forward week yields 4 dates, no gap or duplicate");
});

test("R12: audit instants round-trip exactly as UTC", async () => {
  const u = await makeUser("Pacific/Auckland");
  const instant = "2026-10-09T13:45:12.345Z";
  const t = await makeTask(u.id, { completedAt: instant });

  const back = await withUser(u.id, async (c) => {
    const { rows } = await c.query<{ completed_at: Date }>(
      "SELECT completed_at FROM tasks WHERE id = $1", [t]);
    return rows[0]!.completed_at.toISOString();
  }, runtimePool);

  assert.equal(back, instant, "a timestamptz must survive a round trip to the exact millisecond");
});

test("AT-31: changing a user's timezone rewrites no stored date", async () => {
  const u = await makeUser("America/Edmonton");
  const t = await makeTask(u.id, { deadline: "2026-10-15" });
  await superPool.query(
    `INSERT INTO day_plans (user_id, plan_date, status, accepted_at)
     VALUES ($1,'2026-10-15','accepted', now())`, [u.id]);

  const snapshot = async () => {
    const { rows } = await superPool.query<{ deadline: string; plan_date: string }>(
      `SELECT to_char(t.deadline,'YYYY-MM-DD') AS deadline,
              to_char(p.plan_date,'YYYY-MM-DD') AS plan_date
         FROM tasks t, day_plans p
        WHERE t.id = $1 AND p.user_id = $2`, [t, u.id]);
    return rows[0]!;
  };

  const before = await snapshot();
  await superPool.query("UPDATE users SET timezone='Asia/Kolkata' WHERE id=$1", [u.id]);
  assert.deepEqual(await snapshot(), before,
    "a timezone change must not rewrite any stored calendar date");
  assert.equal(before.deadline, "2026-10-15");
});

test("AT-29: 'today' derives correctly for half-hour and southern-DST zones", async () => {
  const zones = ["Asia/Kolkata", "Australia/Sydney", "America/Edmonton", "Pacific/Auckland"];
  const users = await Promise.all(zones.map((z) => makeUser(z)));

  const days = await Promise.all(users.map((u, i) =>
    withUser(u.id, (c) => todayFor(c, u.id), runtimePool)
      .then((d) => [zones[i]!, d] as const)));

  for (const [zone, day] of days) {
    assert.match(day, /^\d{4}-\d{2}-\d{2}$/, `${zone} must yield a calendar date`);
    // Cross-check against Postgres computing the same thing independently.
    const { rows } = await superPool.query<{ d: string }>(
      "SELECT to_char((now() AT TIME ZONE $1)::date,'YYYY-MM-DD') AS d", [zone]);
    assert.equal(day, rows[0]!.d, `${zone} date must match a direct server computation`);
  }

  // Kolkata is UTC+05:30 — a half-hour offset, which a naive offset-integer
  // model gets wrong. Sydney is on southern-hemisphere DST, inverted from the north.
  assert.equal(days.length, 4);
});
