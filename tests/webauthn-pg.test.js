// SIM-394 - the PgStore leg of the WebAuthn second factor: the FULL ceremony
// round-trip (register x2 -> enforcement arms -> two-step login -> counter
// update) against the real app booted with STORE_BACKEND=pg over an ephemeral
// embedded Postgres (migration 0004 applied by the helper's `migrate up`).
// The FileStore leg + the attack-shaped paths live in
// tests/webauthn-endpoints.test.js; the raw credential CRUD contract runs on
// both backends in tests/store-contract.test.js. This file proves the two
// halves meet: routes + PgStore + the 0004 schema, end to end.
//
// Skips cleanly when the embedded cluster cannot boot (elevated shell /
// offline) - EXCEPT under REQUIRE_EMBEDDED_PG=1, where provisioning failure
// throws (the guardian hard-fail; tests/helpers/embedded-pg.mjs).

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import request from "supertest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import argon2 from "argon2";
import { startCluster } from "./helpers/embedded-pg.mjs";
import { SESSION_COOKIE } from "../server/auth.js";
import { MFA_COOKIE } from "../server/webauthn.js";
import { createAuthenticator, attestationResponse, assertionResponse } from "./helpers/webauthn-mock.mjs";

const PASSPHRASE = "correct-horse-battery";
const RP_ID = "localhost";
const ORIGIN = "https://localhost";

process.env.JOBHUNT_TEST = "1";
const cluster = await startCluster();
const suite = cluster.available ? describe : describe.skip;
if (!cluster.available) {
  // eslint-disable-next-line no-console
  console.warn(`[webauthn-pg] PgStore leg SKIPPED: ${cluster.reason}`);
}

const cookieOf = (res, name) => {
  const set = res.headers["set-cookie"] || [];
  const hit = set.find((c) => c.startsWith(`${name}=`));
  return hit ? hit.split(";")[0] : null;
};

suite("webauthn full ceremony round-trip [PgStore app]", () => {
  let app, tmpRoot, store;

  beforeAll(async () => {
    vi.resetModules();
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "webauthn-pg-"));
    const jobsDir = path.join(tmpRoot, "Jobs");
    const docsDir = path.join(tmpRoot, "docs");
    for (const d of [jobsDir, docsDir]) fs.mkdirSync(d, { recursive: true });
    const hash = await argon2.hash(PASSPHRASE, { type: argon2.argon2id });

    process.env.JOBHUNT_JOBS_DIR = jobsDir;
    process.env.JOBHUNT_DOCS_DIR = docsDir;
    process.env.STORE_BACKEND = "pg";
    process.env.DATABASE_URL = cluster.url;
    process.env.JOBHUNT_AUTH_HASH = hash;
    process.env.JOBHUNT_AUTH_SECRET = "test-fixed-secret-do-not-use-in-prod";
    process.env.JOBHUNT_WEBAUTHN = "on";
    process.env.JOBHUNT_WEBAUTHN_RPID = RP_ID;
    process.env.JOBHUNT_WEBAUTHN_ORIGIN = ORIGIN;
    delete process.env.APP_MODE;
    delete process.env.JOBHUNT_AUTH;

    const mod = await import("../server/index.js");
    app = mod.app;
    store = mod.store;
  });

  afterAll(async () => {
    for (const k of [
      "STORE_BACKEND",
      "DATABASE_URL",
      "JOBHUNT_AUTH_HASH",
      "JOBHUNT_AUTH_SECRET",
      "JOBHUNT_WEBAUTHN",
      "JOBHUNT_WEBAUTHN_RPID",
      "JOBHUNT_WEBAUTHN_ORIGIN",
    ]) {
      delete process.env[k];
    }
    // Close the store's worker connection BEFORE stopping the cluster (the
    // demo-mode.test.js teardown rule).
    try {
      if (store) store.close();
    } catch {}
    if (cluster.available) await cluster.stop();
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    } catch {}
  });

  it("register x2 -> enforcement arms -> passphrase yields pending -> assertion yields session -> counter persisted", async () => {
    // enrollment-mode login (0 credentials in pg)
    const login1 = await request(app).post("/api/auth/login").send({ passphrase: PASSPHRASE });
    expect(login1.body).toEqual({ ok: true });
    const session = cookieOf(login1, SESSION_COOKIE);
    expect(session).toBeTruthy();

    // register two passkeys through the real routes into the pg table
    const a1 = createAuthenticator({ rpId: RP_ID });
    const a2 = createAuthenticator({ rpId: RP_ID });
    for (const [auth, label] of [
      [a1, "pg-key-one"],
      [a2, "pg-key-two"],
    ]) {
      const opt = await request(app).post("/api/webauthn/register/options").set("Cookie", session);
      expect(opt.status).toBe(200);
      const att = attestationResponse(auth, { challenge: opt.body.challenge, origin: ORIGIN });
      const reg = await request(app)
        .post("/api/webauthn/register/verify")
        .set("Cookie", session)
        .send({ response: att, label });
      expect(reg.status).toBe(200);
    }
    expect(store.countWebauthnCredentials()).toBe(2);

    // enforcement armed: passphrase -> pending cookie, no session
    const login2 = await request(app).post("/api/auth/login").send({ passphrase: PASSPHRASE });
    expect(login2.body).toEqual({ ok: true, webauthnRequired: true });
    expect(cookieOf(login2, SESSION_COOKIE)).toBeNull();
    const mfa = cookieOf(login2, MFA_COOKIE);
    expect(mfa).toBeTruthy();

    // assertion ceremony -> real session
    const opt = await request(app).post("/api/webauthn/login/options").set("Cookie", mfa);
    expect(opt.status).toBe(200);
    const asr = assertionResponse(a1, { challenge: opt.body.challenge, origin: ORIGIN, counter: 7 });
    const verify = await request(app).post("/api/webauthn/login/verify").set("Cookie", mfa).send({ response: asr });
    expect(verify.status).toBe(200);
    const session2 = cookieOf(verify, SESSION_COOKIE);
    expect(session2).toBeTruthy();
    expect((await request(app).get("/api/config").set("Cookie", session2)).status).toBe(200);

    // the signature counter round-tripped into the pg row
    const stored = store.listWebauthnCredentials().find((c) => c.label === "pg-key-one");
    expect(stored.counter).toBe(7);
  });
});
