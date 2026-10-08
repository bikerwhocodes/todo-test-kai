// Application-level account isolation (NEXT-2).
//
// The DATABASE-level half is already proven by tests/rls.test.ts and
// tests/owner-safety.test.ts: raw SQL under the runtime role cannot read or
// forge another user's rows, and identity does not leak across pooled
// connections. This file deliberately does not re-prove any of that. It
// proves the half that needs a real session: that a cookie becomes exactly one
// user id, that a second account gets 404 rather than 403, that logout and
// expiry actually revoke, and that the two database roles cannot do each
// other's job.
import { before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { auth } from "../lib/auth.ts";
import * as projectsRoute from "../src/app/api/projects/route.ts";
import * as projectRoute from "../src/app/api/projects/[id]/route.ts";
import { withUser } from "../db/client.ts";
import { runtimePool, superPool } from "./helpers.ts";
import {
  appRequest, authFetch, authRolePool, cookieFrom, nextIp, resetRateLimits,
  routeParams, signIn, signUp,
} from "./auth-helpers.ts";

// See resetRateLimits(): the counters are persisted, so a previous run inside
// the same 60-second window would otherwise 429 this one at sign-up.
before(resetRateLimits);

// ---------------------------------------------------------------------------
// A1 — sign-up, sign-in, sign-out
// ---------------------------------------------------------------------------

test("A1: sign-up creates a uuid-keyed user with a hashed credential", async () => {
  const a = await signUp();

  // A4: the id is a real uuid, not Better Auth's default base62 string. The
  // column is `uuid`, so a base62 id would have been rejected outright.
  assert.match(a.id, /^[0-9a-f]{8}-[0-9a-f]{4}-[1-9a-f][0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/i);

  const { rows } = await superPool.query<{ password: string | null; provider_id: string }>(
    "SELECT password, provider_id FROM accounts WHERE user_id = $1",
    [a.id],
  );
  assert.equal(rows.length, 1, "exactly one credential row");
  const stored = rows[0]!.password;
  assert.ok(stored, "a credential was stored");
  // A9: the password is not recoverable from the row. scrypt (Better Auth's
  // default, the recorded answer to Q-A) stores `salt:derivedKey`.
  assert.notEqual(stored, a.password);
  assert.ok(!stored!.includes(a.password), "the plaintext does not appear in the hash");
  assert.match(stored!, /^[0-9a-f]+:[0-9a-f]+$/, "scrypt salt:key format");

  // The timezone default from 001_schema.sql applies; auth does not set it.
  const u = await superPool.query<{ timezone: string }>(
    "SELECT timezone FROM users WHERE id = $1", [a.id]);
  assert.equal(u.rows[0]!.timezone, "UTC");
});

test("A1: sign-in with the right password works and the wrong one does not", async () => {
  const a = await signUp();

  const good = await signIn(a.email, a.password);
  assert.equal(good.status, 200);
  const session = await auth.api.getSession({
    headers: new Headers({ cookie: cookieFrom(good) }),
  });
  assert.equal(session?.user?.id, a.id);

  const bad = await signIn(a.email, `${a.password}-wrong`);
  assert.ok(bad.status >= 400, `wrong password rejected, got ${bad.status}`);
  assert.equal(cookieFrom(bad), "", "no session cookie is issued on failure");
});

test("A9: the session cookie is HttpOnly, SameSite and Path-scoped", async () => {
  const res = await authFetch({
    path: "/sign-up/email",
    body: { name: "Flags", email: `f-${randomUUID()}@example.test`, password: "Flags-pw-1234" },
  });
  assert.equal(res.ok, true);
  const raw = res.headers.getSetCookie().find((c) => c.includes("session_token"));
  assert.ok(raw, "a session_token cookie was set");
  // Asserted rather than trusted: the library documents these, this proves it.
  assert.match(raw!, /HttpOnly/i);
  assert.match(raw!, /SameSite=Lax/i);
  assert.match(raw!, /Path=\//i);
  // Secure is deliberately off outside production so the cookie works over
  // plain http on localhost; advanced.useSecureCookies turns it on in prod.
  assert.equal(process.env.NODE_ENV === "production", /Secure/.test(raw!));
});

test("A9: sign-out invalidates the session server-side, not just in the browser", async () => {
  const a = await signUp();

  const before = await superPool.query("SELECT 1 FROM sessions WHERE user_id = $1", [a.id]);
  assert.equal(before.rowCount, 1);

  const out = await authFetch({ path: "/sign-out", body: {}, cookie: a.cookie });
  assert.equal(out.status, 200);

  // The row is gone, so the cookie cannot be replayed even if a client keeps it.
  const after = await superPool.query("SELECT 1 FROM sessions WHERE user_id = $1", [a.id]);
  assert.equal(after.rowCount, 0, "the session row was deleted");

  const replay = await projectsRoute.GET(appRequest("/api/projects", { cookie: a.cookie }));
  assert.equal(replay.status, 401, "the revoked cookie no longer authenticates");
});

test("A10: an EXPIRED session is rejected like an absent one", async () => {
  const a = await signUp();

  // Age the session past its expiry. Done as the owner so the test is about
  // expiry handling, not about who may write sessions.
  await superPool.query(
    "UPDATE sessions SET expires_at = now() - interval '1 hour' WHERE user_id = $1",
    [a.id],
  );

  const res = await projectsRoute.GET(appRequest("/api/projects", { cookie: a.cookie }));
  assert.equal(res.status, 401);
  assert.equal((await res.json()).error.code, "UNAUTHENTICATED");
});

// ---------------------------------------------------------------------------
// A10 — unauthenticated access fails safely on every route
// ---------------------------------------------------------------------------

test("A10: every user-scoped route rejects an unauthenticated caller", async () => {
  const id = randomUUID();
  const cases: { name: string; run: () => Promise<Response> }[] = [
    { name: "GET /api/projects", run: () => projectsRoute.GET(appRequest("/api/projects")) },
    {
      name: "POST /api/projects",
      run: () => projectsRoute.POST(appRequest("/api/projects", { method: "POST", body: { name: "x" } })),
    },
    {
      name: "GET /api/projects/:id",
      run: () => projectRoute.GET(appRequest(`/api/projects/${id}`), routeParams(id)),
    },
    {
      name: "PATCH /api/projects/:id",
      run: () => projectRoute.PATCH(
        appRequest(`/api/projects/${id}`, { method: "PATCH", body: { name: "x" } }),
        routeParams(id),
      ),
    },
    {
      name: "DELETE /api/projects/:id",
      run: () => projectRoute.DELETE(
        appRequest(`/api/projects/${id}`, { method: "DELETE" }), routeParams(id),
      ),
    },
  ];

  for (const c of cases) {
    const res = await c.run();
    assert.equal(res.status, 401, `${c.name} → 401`);
    assert.equal((await res.json()).error.code, "UNAUTHENTICATED", `${c.name} → UNAUTHENTICATED`);
  }

  // No row was created by any rejected call.
  const { rows } = await runtimePool.query("SELECT 1 FROM projects WHERE name = 'x'");
  assert.equal(rows.length, 0, "a rejected POST wrote nothing");
});

// ---------------------------------------------------------------------------
// A2, A3 — two accounts
// ---------------------------------------------------------------------------

test("A3: user B gets 404 — not 403 — for every operation on A's project", async () => {
  const [a, b] = [await signUp(), await signUp()];

  const created = await projectsRoute.POST(
    appRequest("/api/projects", { method: "POST", cookie: a.cookie, body: { name: "A's roadmap" } }),
  );
  assert.equal(created.status, 201);
  const projectId: string = (await created.json()).project.id;

  const victimBefore = await snapshotProject(projectId);

  const attempts: { name: string; run: () => Promise<Response> }[] = [
    {
      name: "read",
      run: () => projectRoute.GET(
        appRequest(`/api/projects/${projectId}`, { cookie: b.cookie }), routeParams(projectId),
      ),
    },
    {
      name: "rename",
      run: () => projectRoute.PATCH(
        appRequest(`/api/projects/${projectId}`, {
          method: "PATCH", cookie: b.cookie, body: { name: "stolen" },
        }),
        routeParams(projectId),
      ),
    },
    {
      name: "delete",
      run: () => projectRoute.DELETE(
        appRequest(`/api/projects/${projectId}`, { method: "DELETE", cookie: b.cookie }),
        routeParams(projectId),
      ),
    },
  ];

  for (const attempt of attempts) {
    const res = await attempt.run();
    assert.equal(res.status, 404, `${attempt.name} → 404`);
    assert.notEqual(res.status, 403, `${attempt.name} must never be 403`);
    assert.equal((await res.json()).error.code, "NOT_FOUND", `${attempt.name} → NOT_FOUND`);
  }

  // E1: the victim row is byte-identical afterwards — nothing was mutated and
  // nothing was deleted.
  assert.deepEqual(await snapshotProject(projectId), victimBefore);
  assert.equal(victimBefore?.name, "A's roadmap");
});

test("A3: another user's id is indistinguishable from an id that never existed", async () => {
  const [a, b] = [await signUp(), await signUp()];

  const created = await projectsRoute.POST(
    appRequest("/api/projects", { method: "POST", cookie: a.cookie, body: { name: "Private" } }),
  );
  const realButForeign: string = (await created.json()).project.id;
  const neverExisted = randomUUID();

  const foreign = await projectRoute.GET(
    appRequest(`/api/projects/${realButForeign}`, { cookie: b.cookie }),
    routeParams(realButForeign),
  );
  const absent = await projectRoute.GET(
    appRequest(`/api/projects/${neverExisted}`, { cookie: b.cookie }),
    routeParams(neverExisted),
  );

  assert.equal(foreign.status, absent.status);
  // Byte-identical bodies: the response cannot be used as an existence oracle.
  assert.equal(await foreign.text(), await absent.text());
});

test("A2: B's list contains only B's projects", async () => {
  const [a, b] = [await signUp(), await signUp()];

  for (const [who, name] of [[a, "A-one"], [a, "A-two"], [b, "B-one"]] as const) {
    const res = await projectsRoute.POST(
      appRequest("/api/projects", { method: "POST", cookie: who.cookie, body: { name } }),
    );
    assert.equal(res.status, 201);
  }

  const listB = (await (await projectsRoute.GET(
    appRequest("/api/projects", { cookie: b.cookie }),
  )).json()).projects as { name: string }[];
  assert.deepEqual(listB.map((p) => p.name), ["B-one"]);

  const listA = (await (await projectsRoute.GET(
    appRequest("/api/projects", { cookie: a.cookie }),
  )).json()).projects as { name: string }[];
  assert.deepEqual(listA.map((p) => p.name).sort(), ["A-one", "A-two"]);
});

test("A3: a malformed id is 404, not a 422 that confirms the format", async () => {
  const a = await signUp();
  const res = await projectRoute.GET(
    appRequest("/api/projects/not-a-uuid", { cookie: a.cookie }), routeParams("not-a-uuid"),
  );
  assert.equal(res.status, 404);
  assert.equal((await res.json()).error.code, "NOT_FOUND");
});

test("validation failures are 422 with a field path and write nothing", async () => {
  const a = await signUp();
  for (const body of [{}, { name: "" }, { name: "   " }, { name: "x".repeat(201) }]) {
    const res = await projectsRoute.POST(
      appRequest("/api/projects", { method: "POST", cookie: a.cookie, body }),
    );
    assert.equal(res.status, 422, `${JSON.stringify(body)} → 422`);
    const payload = await res.json();
    assert.equal(payload.error.code, "VALIDATION_FAILED");
    assert.deepEqual(payload.error.details.path, ["name"]);
  }
  const after = (await (await projectsRoute.GET(
    appRequest("/api/projects", { cookie: a.cookie }),
  )).json()).projects;
  assert.equal(after.length, 0, "no project was created by a rejected request");
});

test("A3: a forged or tampered session cookie does not authenticate", async () => {
  // Found by mutation testing: nothing else in this file proves that identity
  // comes from a SIGNED cookie rather than from whatever the client sends.
  // Without this, a requireUser() that trusted an unsigned client value would
  // pass the whole suite.
  const a = await signUp();

  const [name, value] = a.cookie.split("=") as [string, string];
  const forgeries: [string, string][] = [
    ["flipped last character", `${name}=${value.slice(0, -1)}${value.at(-1) === "A" ? "B" : "A"}`],
    ["signature stripped", `${name}=${value.split(".")[0] ?? value}`],
    ["another token entirely", `${name}=${randomUUID()}`],
    ["empty", `${name}=`],
  ];

  for (const [label, cookie] of forgeries) {
    const res = await projectsRoute.GET(appRequest("/api/projects", { cookie }));
    assert.equal(res.status, 401, `${label} → 401`);
  }

  // The genuine cookie still works, so the rejections are the signature check
  // and not a broken cookie name.
  const good = await projectsRoute.GET(appRequest("/api/projects", { cookie: a.cookie }));
  assert.equal(good.status, 200);
});

test("A5: RLS alone blocks a cross-owner read even with NO application predicate", async () => {
  // Also found by mutation testing: deleting `AND user_id = $2` from
  // db/projects.ts did not fail a single test, because row-level security
  // caught it. That is defence in depth working — but it was unasserted, so
  // nothing recorded that the second layer is what held. This asserts it.
  const [a, b] = [await signUp(), await signUp()];

  const created = await projectsRoute.POST(
    appRequest("/api/projects", { method: "POST", cookie: a.cookie, body: { name: "A only" } }),
  );
  const projectId: string = (await created.json()).project.id;

  // The query a buggy repository would emit: by id, with no owner predicate,
  // under the real runtime role with B's identity bound.
  const rows = await withUser(b.id, async (c) => {
    const r = await c.query("SELECT id, name FROM projects WHERE id = $1", [projectId]);
    return r.rows;
  });
  assert.deepEqual(rows, [], "RLS returns zero rows for an unscoped cross-owner read");

  // And a forged insert naming A as owner is rejected by WITH CHECK.
  await assert.rejects(
    () => withUser(b.id, (c) =>
      c.query("INSERT INTO projects (user_id, name) VALUES ($1, $2)", [a.id, "forged"])),
    (err: { code?: string }) => err.code === "42501",
    "a forged cross-owner insert is rejected",
  );

  const check = await superPool.query("SELECT 1 FROM projects WHERE name = 'forged'");
  assert.equal(check.rowCount, 0);
});

// ---------------------------------------------------------------------------
// A9 — CSRF and rate limiting
// ---------------------------------------------------------------------------

test("A9: a cross-origin sign-in attempt is rejected (CSRF)", async () => {
  const a = await signUp();

  const hostile = await authFetch({
    path: "/sign-in/email",
    body: { email: a.email, password: a.password },
    origin: "https://evil.example",
  });
  assert.ok(hostile.status >= 400, `hostile origin rejected, got ${hostile.status}`);
  assert.equal(cookieFrom(hostile), "", "no session cookie issued to a hostile origin");

  // The same request from the trusted origin succeeds, so the rejection is the
  // origin check and not a broken request.
  const trusted = await signIn(a.email, a.password);
  assert.equal(trusted.status, 200);
});

test("A9: a cross-origin state-changing call with a valid cookie is rejected (CSRF)", async () => {
  const a = await signUp();
  const hostile = await authFetch({ path: "/sign-out", body: {}, cookie: a.cookie, origin: "https://evil.example" });
  assert.ok(hostile.status >= 400, `cross-origin sign-out rejected, got ${hostile.status}`);

  // The session survived the attempt.
  const still = await superPool.query("SELECT 1 FROM sessions WHERE user_id = $1", [a.id]);
  assert.equal(still.rowCount, 1, "a CSRF sign-out did not revoke the victim's session");
});

test("A9: repeated sign-in attempts from one ip are rate limited to 429", async () => {
  const a = await signUp();
  const ip = "198.51.100.7"; // one fixed ip, so all attempts share a bucket
  const statuses: number[] = [];

  // customRules caps /sign-in/email at 5 per 60s.
  for (let i = 0; i < 9; i++) {
    const res = await signIn(a.email, `${a.password}-wrong`, ip);
    statuses.push(res.status);
    if (res.status === 429) break;
  }

  assert.ok(statuses.includes(429), `expected a 429, got ${statuses.join(", ")}`);
  assert.ok(statuses.indexOf(429) <= 6, `limit should bite early, got ${statuses.join(", ")}`);

  // storage: "database" — the counter is persisted, not per-process memory.
  const { rows } = await authRolePool.query<{ count: number }>(
    "SELECT count FROM rate_limits WHERE key = $1", [`${ip}|/sign-in/email`],
  );
  assert.equal(rows.length, 1, "the counter was persisted to rate_limits");
  assert.ok(rows[0]!.count >= 5);

  // A different ip is unaffected — the limiter is not a global kill switch.
  const other = await signIn(a.email, a.password, "203.0.113.42");
  assert.equal(other.status, 200);
});

// ---------------------------------------------------------------------------
// P11 — the two roles cannot do each other's job
// ---------------------------------------------------------------------------

test("P11: the application runtime role has NO access to the session tables", async () => {
  // This is the whole reason for a third role. If this test fails, every
  // application query can read every session token in the database.
  for (const table of ["sessions", "accounts", "verifications", "rate_limits"]) {
    await assert.rejects(
      () => runtimePool.query(`SELECT * FROM ${table} LIMIT 1`),
      (err: { code?: string }) => err.code === "42501",
      `runtime role must be denied SELECT on ${table}`,
    );
  }
});

test("P11: the auth role has NO access to any user-data table", async () => {
  for (const table of [
    "projects", "tasks", "task_dependencies", "recurrence_rules", "day_plans", "day_plan_items",
  ]) {
    await assert.rejects(
      () => authRolePool.query(`SELECT * FROM ${table} LIMIT 1`),
      (err: { code?: string }) => err.code === "42501",
      `auth role must be denied SELECT on ${table}`,
    );
  }
});

test("P11: the auth role may read any user row but may not delete one", async () => {
  const a = await signUp();

  // It must see rows it does not own — sign-in looks a user up by email before
  // any identity exists, which is exactly why users_auth is scoped TO this role.
  const { rows } = await authRolePool.query<{ id: string }>(
    "SELECT id FROM users WHERE email = $1", [a.email],
  );
  assert.equal(rows[0]?.id, a.id, "the auth role resolves a user pre-identity");

  // Deleting a user cascades to all of their data, so that privilege is withheld.
  await assert.rejects(
    () => authRolePool.query("DELETE FROM users WHERE id = $1", [a.id]),
    (err: { code?: string }) => err.code === "42501",
    "the auth role must not be able to delete an account",
  );
  const still = await superPool.query("SELECT 1 FROM users WHERE id = $1", [a.id]);
  assert.equal(still.rowCount, 1);
});

test("P11: the runtime role still sees only its OWN users row", async () => {
  // The users_auth policy must not have widened the runtime role's view.
  const [a, b] = [await signUp(), await signUp()];
  const client = await runtimePool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.user_id', $1, true)", [a.id]);
    const { rows } = await client.query<{ id: string }>("SELECT id FROM users");
    await client.query("COMMIT");
    assert.deepEqual(rows.map((r) => r.id), [a.id], "A sees exactly one users row: its own");
    assert.ok(!rows.some((r) => r.id === b.id), "A cannot see B's users row");
  } finally {
    client.release();
  }
});

test("P11: the auth role is not a superuser and cannot bypass RLS", async () => {
  const { rows } = await authRolePool.query<{
    rolsuper: boolean; rolbypassrls: boolean; owns: boolean;
  }>(`SELECT r.rolsuper, r.rolbypassrls,
             pg_get_userbyid((SELECT c.relowner FROM pg_class c
               WHERE c.relname = 'users' AND c.relnamespace = 'public'::regnamespace))
               = current_user AS owns
        FROM pg_roles r WHERE r.rolname = current_user`);
  const r = rows[0]!;
  assert.equal(r.rolsuper, false);
  assert.equal(r.rolbypassrls, false);
  assert.equal(r.owns, false, "the auth role does not own the tables, so it cannot disable RLS");
});

// ---------------------------------------------------------------------------
// Structural invariants
// ---------------------------------------------------------------------------

test("A3: no source file produces a 403", async () => {
  // A3 is a property of every route, present and future. A behavioural test
  // can only cover the routes that exist today; this covers the ones NEXT-3+
  // will add.
  const offenders: string[] = [];
  for (const file of await sourceFiles(["lib", "db", "src"])) {
    const text = await readFile(file, "utf8");
    for (const [i, line] of text.split("\n").entries()) {
      if (/\b403\b/.test(line) && !/^\s*(\/\/|\*)/.test(line)) {
        offenders.push(`${file}:${i + 1}: ${line.trim()}`);
      }
    }
  }
  assert.deepEqual(offenders, [], "A3 forbids 403; use 404 so existence is not confirmed");
});

test("the startup guard rejects an un-RLS'd table and an unclassified one", async () => {
  const { assertRlsCoverage, checkRlsCoverage } = await import("../db/guard.ts");
  const runtimeUrl = process.env.DATABASE_URL!;
  const ownerUrl = process.env.MIGRATION_DATABASE_URL!;

  // Passes as shipped.
  await assertRlsCoverage(runtimeUrl);

  // A new table with no policy and no documented exemption is what the
  // allowlist exists to catch. Created and dropped as the owner.
  const owner = await superPool.connect();
  try {
    await owner.query("CREATE TABLE guard_probe_unclassified (id uuid PRIMARY KEY)");
    const coverage = await checkRlsCoverage(runtimeUrl);
    assert.deepEqual(coverage.unclassified, ["guard_probe_unclassified"]);
    assert.equal(coverage.safe, false);
    await assert.rejects(
      () => assertRlsCoverage(runtimeUrl),
      /neither the protected list nor the documented exemptions/,
    );
  } finally {
    await owner.query("DROP TABLE IF EXISTS guard_probe_unclassified");
    owner.release();
  }

  // And a protected table that loses FORCE is caught too.
  const o2 = await superPool.connect();
  try {
    await o2.query("ALTER TABLE projects NO FORCE ROW LEVEL SECURITY");
    const coverage = await checkRlsCoverage(runtimeUrl);
    assert.deepEqual(coverage.missing, ["projects"]);
    await assert.rejects(() => assertRlsCoverage(runtimeUrl), /ENABLE\/FORCE/);
  } finally {
    await o2.query("ALTER TABLE projects FORCE ROW LEVEL SECURITY");
    o2.release();
  }

  // Restored, so the suite leaves the database as it found it.
  await assertRlsCoverage(runtimeUrl);
  assert.ok(ownerUrl, "owner url is configured");
});

async function snapshotProject(id: string): Promise<Record<string, unknown> | null> {
  const { rows } = await superPool.query(
    "SELECT id, user_id, name, archived_at, created_at FROM projects WHERE id = $1", [id],
  );
  return rows[0] ?? null;
}

async function sourceFiles(dirs: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const dir of dirs) {
    for (const entry of await readdir(dir, { withFileTypes: true, recursive: true })) {
      if (!entry.isFile()) continue;
      if (!/\.(ts|tsx)$/.test(entry.name)) continue;
      out.push(join(entry.parentPath ?? dir, entry.name));
    }
  }
  return out;
}
