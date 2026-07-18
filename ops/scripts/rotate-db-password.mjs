// One-off: rotate the Postgres password. Connects with the CURRENT DATABASE_URL,
// runs ALTER USER, then verifies the NEW password actually connects — so you never
// update Railway to a password that doesn't work.
//
// Usage (proxy open, current DATABASE_URL set, new password in NEW_DB_PASSWORD):
//   $env:NEW_DB_PASSWORD = Get-Clipboard
//   node ops/scripts/rotate-db-password.mjs
//
// The new password is read from the env / clipboard and never printed.
import pg from "pg";

const url = process.env.DATABASE_URL;
const np = process.env.NEW_DB_PASSWORD;
if (!url) { console.error("rotate: DATABASE_URL not set (the CURRENT connection)."); process.exit(1); }
if (!np)  { console.error("rotate: NEW_DB_PASSWORD not set (put the new password there)."); process.exit(1); }
if (!/^[A-Za-z0-9]{16,}$/.test(np)) {
  console.error("rotate: new password must be 16+ chars, letters/digits only (keeps it URL-safe). Regenerate and retry.");
  process.exit(1);
}

// 1. Change the password on the database, using the current (old) credentials.
const admin = new pg.Client({ connectionString: url });
try {
  await admin.connect();
  await admin.query(`ALTER USER postgres WITH PASSWORD '${np}'`); // np is validated [A-Za-z0-9]+ above
  console.log("rotate: ALTER USER succeeded — the database password is changed.");
} catch (e) {
  console.error("rotate: FAILED to change the password —", e.message);
  await admin.end().catch(() => {});
  process.exit(1);
}
await admin.end().catch(() => {});

// 2. Verify the NEW password connects (swap only the password in the URL).
const newUrl = url.replace(/(postgres(?:ql)?:\/\/[^:@/]+:)[^@]+@/, `$1${np}@`);
const check = new pg.Client({ connectionString: newUrl });
try {
  await check.connect();
  await check.query("select 1");
  console.log("rotate: VERIFIED — the new password connects. Next: set it in Railway (PGPASSWORD + the URLs), then redeploy the app.");
} catch (e) {
  console.error("rotate: WARNING — new password did not verify:", e.message, "\n(The ALTER may still have applied — check before updating Railway.)");
  process.exitCode = 1;
} finally {
  await check.end().catch(() => {});
}
