#!/usr/bin/env node
// ops/auth-setup.mjs - provision the jobhunt app passphrase (SIM-85 / RC-1).
//
// Writes an Argon2id hash of a passphrase you choose to <DATA_DIR>/auth.json,
// which lives OUTSIDE the git tree (ssc-brain\data\jobhunt) alongside the live
// board stores. The running server activates auth automatically once this file
// exists (or set JOBHUNT_AUTH=required to also fail-fast if it is missing).
//
//   node ops/auth-setup.mjs                 # interactive, hidden passphrase entry
//   JOBHUNT_SETUP_PASSPHRASE=... node ops/auth-setup.mjs   # non-interactive (CI)
//
// The passphrase is never printed and never written in plaintext - only its
// Argon2id hash plus a random session-signing secret are persisted (mode 0600).

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import argon2 from "argon2";
import { resolveDataDir } from "../server/lib.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const MIN_LEN = 8;

// Hidden, masked interactive input (no echo of the passphrase characters).
function promptHidden(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl.stdoutMuted = true;
    // Mask every echoed character while muted; still print the prompt itself.
    rl._writeToOutput = function (str) {
      if (rl.stdoutMuted && str !== question) rl.output.write("*");
      else rl.output.write(str);
    };
    rl.question(question, (answer) => {
      rl.close();
      process.stdout.write("\n");
      resolve(answer);
    });
  });
}

async function getPassphrase() {
  // Non-interactive path for CI / scripted setup.
  const fromEnv = process.env.JOBHUNT_SETUP_PASSPHRASE;
  if (fromEnv) return { passphrase: fromEnv, interactive: false };

  if (!process.stdin.isTTY) {
    console.error(
      "[auth-setup] no TTY and JOBHUNT_SETUP_PASSPHRASE is unset - cannot read a passphrase.",
    );
    process.exit(2);
  }
  const first = await promptHidden("New app passphrase: ");
  const second = await promptHidden("Confirm passphrase: ");
  if (first !== second) {
    console.error("[auth-setup] passphrases did not match - nothing written.");
    process.exit(2);
  }
  return { passphrase: first, interactive: true };
}

async function main() {
  const { passphrase } = await getPassphrase();
  if (typeof passphrase !== "string" || passphrase.length < MIN_LEN) {
    console.error(`[auth-setup] passphrase must be at least ${MIN_LEN} characters - nothing written.`);
    process.exit(2);
  }

  const dataDir = resolveDataDir(REPO_ROOT);
  fs.mkdirSync(dataDir, { recursive: true });
  const outPath = path.join(dataDir, "auth.json");

  const hash = await argon2.hash(passphrase, { type: argon2.argon2id });
  const secret = crypto.randomBytes(32).toString("hex");
  const record = {
    algo: "argon2id",
    hash,
    secret,
    createdAt: new Date().toISOString(),
  };

  // 0600: readable only by the owner. Written atomically-ish via a temp file to
  // avoid a truncated config if the process dies mid-write.
  const tmp = `${outPath}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(record, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, outPath);
  try {
    fs.chmodSync(outPath, 0o600);
  } catch {
    /* chmod is a no-op on some Windows filesystems; the data zone is already user-scoped */
  }

  console.log(`[auth-setup] wrote Argon2id passphrase hash to ${outPath} (mode 0600)`);
  console.log("[auth-setup] the server enables auth automatically on next start.");
  console.log("[auth-setup] to make it MANDATORY (fail-fast if the hash is missing):");
  console.log("[auth-setup]   set JOBHUNT_AUTH=required");
}

main().catch((e) => {
  console.error(`[auth-setup] failed: ${e && e.message ? e.message : e}`);
  process.exit(1);
});
