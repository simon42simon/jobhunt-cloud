/* eslint-disable */
// SIM-394 - webauthn_credentials: the passkey second factor's credential store
// (data-schema.md section 2.12; feature-flagged by JOBHUNT_WEBAUTHN, rows are
// inert while the flag is off).
//
// VANILLA PG ONLY (the 0001 pin): text, bigint, text[], timestamptz - no
// extensions. The credential id is authenticator-minted (base64url), so no
// uuid/pgcrypto is needed. counter is bigint because the WebAuthn signature
// counter is a uint32 (max 4294967295), which overflows int4.
//
// ORDERING RULE (the bd4e5f7 bug class, fixed pattern from 0003): statements go
// through pgm.db.query - IMMEDIATE execution in the order written - never
// pgm.sql, whose collected statements the runner executes only after the async
// body resolves (that reordering broke every `migrate up` on 0003 until fixed).
// Re-runnable: CREATE TABLE IF NOT EXISTS.

exports.shorthands = undefined;

exports.up = async (pgm) => {
  await pgm.db.query(`
  CREATE TABLE IF NOT EXISTS webauthn_credentials (
    id          text PRIMARY KEY,
    public_key  text NOT NULL,
    counter     bigint NOT NULL DEFAULT 0,
    transports  text[] NOT NULL DEFAULT '{}',
    label       text,
    created_at  timestamptz NOT NULL DEFAULT now()
  );`);
};

exports.down = async (pgm) => {
  await pgm.db.query(`DROP TABLE IF EXISTS webauthn_credentials;`);
};
