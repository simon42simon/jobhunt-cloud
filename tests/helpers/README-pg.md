# PgStore tests: the ephemeral Postgres, and how to run it on Windows

RC-3 / SIM-87 (I3+I4). The PgStore contract + differential suites boot a **real,
throwaway PostgreSQL** via [`embedded-postgres`](https://www.npmjs.com/package/embedded-postgres)
(real PG binaries, no Docker, no system service). All of it is a **devDependency**,
so `npm run lint:audit` (`--omit=dev`) never sees it.

## What runs where

- `tests/store-contract.test.js` - the ONE parameterized contract suite. FileStore
  always runs; **PgStore is added as a second backend row** when a cluster can be
  provisioned. Same test bodies, both backends.
- `tests/pg-filestore-differential.test.js` - drives identical operations through
  both stores and asserts the returned domain objects agree.
- `tests/helpers/embedded-pg.mjs` - boots the cluster, runs `migrations/0001_init`
  up, hands back the PgStore backend. Boots are **fail-safe**: any provisioning
  failure -> the PgStore row/suite is skipped with a clear note, and the gate stays
  green.

## The Windows admin-token gotcha (why a plain `npm run check` skips PgStore here)

`postgres.exe` **refuses to run under an administrative token**:

> Execution of PostgreSQL by a user with administrative permissions is not permitted.

If your shell is **elevated** (Windows UAC is on and the process is elevated),
`pg.start()` fails and PgStore is skipped - the suite still passes on FileStore.
This is expected and safe. To actually **exercise PgStore**, run the tests from a
**non-elevated (medium-integrity) context**.

### Recipe: run de-elevated via a scheduled task (PowerShell)

```powershell
$repo = "C:\path\to\mabrain-jobhunt"
$node = (Get-Command node).Source
$log  = "$repo\_pgtest.log"
$cmd  = "@echo off`r`n`"$node`" node_modules\vitest\vitest.mjs run tests/store-contract.test.js tests/pg-filestore-differential.test.js > `"$log`" 2>&1"
Set-Content "$repo\_pgtest.cmd" $cmd -Encoding ascii
$a = New-ScheduledTaskAction -Execute "$repo\_pgtest.cmd" -WorkingDirectory $repo
$p = New-ScheduledTaskPrincipal -UserId $env:USERNAME -RunLevel Limited -LogonType Interactive
Register-ScheduledTask -TaskName pgtest -Action $a -Principal $p -Force | Out-Null
Start-ScheduledTask -TaskName pgtest
# wait for State -> Ready, then:  Get-Content $log
```

`-RunLevel Limited` gives the task the user's **filtered** (non-admin) token, which
is exactly what `postgres.exe` requires.

On Linux/macOS and on CI runners that are not elevated, no special handling is
needed - the cluster just boots. If the binary download fails (offline), the suite
skips cleanly; CI should note the skip rather than treat it as a pass of PgStore.
