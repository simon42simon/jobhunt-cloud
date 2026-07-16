@echo off
REM SIM-68 (2026-07-14): channel selector, EXTRACTED from start-app.cmd so it can be
REM smoke-tested under cmd.exe without launching the app. start-app.cmd `call`s this in
REM place of the old inline :choose_channel subroutine, so the LIVE serving path runs the
REM exact same selection code the test suite (tests/choose-channel.test.js) exercises.
REM
REM Contract:
REM   INPUTS  (from the environment - start-app sets them at top; the test injects them):
REM     MAIN_DIR   - the main checkout root (dev-fallback serves from here)
REM     STABLE_DIR - the pinned stable worktree (stable channel serves from here)
REM     SSC_ROOT   - ssc-brain root (only used to name the data zone env; not part of the
REM                  channel decision)
REM     APP_LOG    - OPTIONAL. When defined, the fallback/degraded cases log one loud line
REM                  there (live behavior). When UNdefined (the test), logging is skipped.
REM   OUTPUTS:
REM     Sets CHANNEL and (built case only) JOBHUNT_SERVE_BUILT in the caller's environment
REM     - this is why start-app `call`s it WITHOUT setlocal, so the set/cd persist. Also
REM     echoes two machine-readable lines to stdout for the test to parse:
REM       CHANNEL=<kind> <dir>
REM       JOBHUNT_SERVE_BUILT=<1|empty>
REM   NEVER launches anything, binds a port, or starts/stops a process. Pure selection.
REM
REM FLAT goto form - no nested if-blocks and no literal parens in any CHANNEL value. The
REM v0.38.0 board outage (postmortem 2026-07-14) was a literal "(...)" in a set-value
REM inside a nested block failing to parse; this shape avoids both. See start-app.cmd.

set "CHANNEL="
set "JOBHUNT_SERVE_BUILT="
if not exist "%STABLE_DIR%\package.json" goto :cc_dev
if not exist "%STABLE_DIR%\node_modules\.bin\vite.cmd" goto :cc_broken
cd /d "%STABLE_DIR%"
set "JOBHUNT_DOCS_DIR=%MAIN_DIR%\docs"
REM ADR-023: JOBHUNT_DOCS_DIR doubles as the server's TEST seam; when set, the server
REM keeps data beside docs, so the stable channel names the live data zone EXPLICITLY.
set "JOBHUNT_DATA_DIR=%SSC_ROOT%\data\jobhunt"
REM SIM-67 REVERTED (2026-07-14 night, owner-approved): moving Jobs\ to the data zone SPLIT it
REM from the rest of the job-hunt workspace. The app derives WORKSPACE_DIR = dirname(JOBS_DIR), so
REM redirecting JOBS_DIR pulled the whole workspace root to data\jobhunt - but the discovery/CV
REM toolchain (ops/scripts, the Job Discovery workbook, the master CV) and the owner's NEWEST CVs
REM (written by the agents) all live in the vault workspace. Result: split-brain + broken discovery.
REM So we DO NOT override JOBHUNT_JOBS_DIR anymore - the stable config.json's jobsDir (the vault
REM workspace Jobs) wins, keeping Jobs + ops together and consistent with the agents. Board DATA
REM (tasks/requests/activity-log) stays in the data zone via JOBHUNT_DATA_DIR above (ADR-023, correct).
REM Proper single-home reconciliation (or decoupling WORKSPACE_DIR from JOBS_DIR) = follow-up ticket.
REM (was: set "JOBHUNT_JOBS_DIR=%SSC_ROOT%\data\jobhunt\Jobs")
if not exist "%STABLE_DIR%\dist\index.html" goto :cc_stable_dev_nodist
findstr /c:"JOBHUNT_SERVE_BUILT" "%STABLE_DIR%\server\index.js" >nul 2>&1
if errorlevel 1 goto :cc_stable_dev_oldserver
set "JOBHUNT_SERVE_BUILT=1"
set "CHANNEL=stable-built %STABLE_DIR%"
goto :cc_emit

:cc_stable_dev_nodist
if defined APP_LOG echo ===== STABLE dist\ missing - serving stable via dev server; re-run ops\scripts\promote-stable.cmd to build: %DATE% %TIME% ===== >> "%APP_LOG%"
set "CHANNEL=stable-dev %STABLE_DIR%"
goto :cc_emit

:cc_stable_dev_oldserver
if defined APP_LOG echo ===== STABLE server predates built-serve - serving stable via dev server so :5180 binds: %DATE% %TIME% ===== >> "%APP_LOG%"
set "CHANNEL=stable-dev %STABLE_DIR%"
goto :cc_emit

:cc_broken
if defined APP_LOG echo ===== STABLE CHANNEL BROKEN - vite missing in %STABLE_DIR%\node_modules\.bin - falling back to dev; re-run ops\scripts\promote-stable.cmd to repair: %DATE% %TIME% ===== >> "%APP_LOG%"
:cc_dev
cd /d "%MAIN_DIR%"
set "JOBHUNT_DOCS_DIR="
set "CHANNEL=dev-fallback %MAIN_DIR%"
goto :cc_emit

:cc_emit
echo CHANNEL=%CHANNEL%
echo JOBHUNT_SERVE_BUILT=%JOBHUNT_SERVE_BUILT%
goto :eof
