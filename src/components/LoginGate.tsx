import { useEffect, useState } from "react";
import { api } from "../api";
import { loginErrorMessage, passkeyErrorMessage, setAuthStatus, useAuthStatus } from "../lib/authSession";
import { passkeyLogin, PasskeyStepError } from "../lib/passkeys";
import { PasskeyManager } from "./PasskeyManager";

// The login gate for the auth-walled private instance (SIM-391; server side is
// server/auth.js, ADR-024). Wraps the WHOLE app in main.tsx, so the boot order
// is structural, not conventional: GET /api/auth/status is the only request
// that can fire before the gate passes - App (and every data hook in it) mounts
// only once auth is off or the session is live, and unmounts again if a
// mid-session 401 flips the store (lib/authSession). Auth OFF - the laptop dev
// posture and the public demo - renders children unchanged: the status probe
// 404s there (an auth-off server registers no /api/auth/* routes) and maps to
// { authRequired:false }, byte-identical behavior to before this gate existed.
//
// SIM-394 (reconciled here per the guardian mirror condition M1 - ONE gate,
// extended, never a second component): when the server's JOBHUNT_WEBAUTHN flag
// is on AND >=2 passkeys are enrolled, POST /api/auth/login answers
// { ok:true, webauthnRequired:true } instead of a session, and the card runs a
// second step (passkey assertion) before re-probing status. With the flag off
// the status body has no `webauthn` key, webauthnRequired never arrives, and
// every render path below is IDENTICAL to the pre-SIM-394 gate - locked card
// and unlocked pass-through alike (pinned by tests/login-gate.test.ts and the
// byte-identity suite in tests/webauthn-endpoints.test.js). In enrollment mode
// (flag on, <2 passkeys) the passphrase alone still logs in and a dismissible
// banner nags to finish enrollment (the anti-lockout semantics, DEPLOYMENT.md).
export function LoginGate({ children }: { children: React.ReactNode }) {
  const status = useAuthStatus();
  const [managerOpen, setManagerOpen] = useState(false);
  const [nagDismissed, setNagDismissed] = useState(false);

  useEffect(() => {
    // Probe once on mount (idempotent under StrictMode's double-invoke). Any
    // failure - 404 on an auth-off server, network refusal - means "no gate":
    // the app then behaves exactly as it always has, including its own
    // could-not-reach error state if the server is genuinely down.
    api.getAuthStatus().then(setAuthStatus).catch(() => setAuthStatus({ authRequired: false, authenticated: true }));
  }, []);

  // One tiny fetch of nothing-but-flags stands between paint and verdict; hold
  // chrome rather than flash a shell whose every request would 401.
  if (!status) return null;
  if (status.authRequired && !status.authenticated) return <LoginCard />;

  // SIM-394: flag off (no webauthn key in the status body) renders children
  // EXACTLY as before - no banner, no pill, no manager, nothing mounted.
  if (!status.webauthn?.enabled) return <>{children}</>;

  // Flag on: the app, plus the enrollment surfaces.
  const enrolling = status.webauthn.enrolling;
  return (
    <>
      {enrolling && !nagDismissed && (
        <div
          role="status"
          className="flex items-center justify-between gap-3 border-b border-[var(--color-edge)] bg-[var(--color-panel)] px-4 py-2 text-[12px] text-[var(--color-text)]"
        >
          <span>
            Passkey enrollment incomplete: the second factor stays OFF until at least 2 passkeys are
            registered. Passphrase-only login still works.
          </span>
          <span className="flex shrink-0 gap-2">
            <button
              type="button"
              className="rounded border border-[var(--color-edge)] px-3 py-1.5 text-[12px] hover:bg-[var(--color-edge)]"
              onClick={() => setManagerOpen(true)}
            >
              Manage passkeys
            </button>
            <button
              type="button"
              className="rounded border border-[var(--color-edge)] px-3 py-1.5 text-[12px] hover:bg-[var(--color-edge)]"
              onClick={() => setNagDismissed(true)}
            >
              Dismiss
            </button>
          </span>
        </div>
      )}
      {children}
      <button
        type="button"
        className="fixed bottom-3 right-3 z-40 rounded-full border border-[var(--color-edge)] bg-[var(--color-panel)] px-3 py-1.5 text-[11px] text-[var(--color-muted)] shadow hover:text-[var(--color-text)]"
        onClick={() => setManagerOpen(true)}
      >
        Passkeys
      </button>
      {managerOpen && <PasskeyManager onClose={() => setManagerOpen(false)} />}
    </>
  );
}

// The centered login card - the ONLY thing on screen while locked (no app
// chrome, nothing to probe). Calm system-readout voice: this is the owner's
// private instance stating a fact, not a marketing page. SIM-394 adds the
// conditional second step INSIDE the same card: step "passphrase" renders the
// pre-SIM-394 card unchanged; step "passkey" (reached only when the server
// answers webauthnRequired) swaps the form for the assertion prompt.
function LoginCard() {
  const [passphrase, setPassphrase] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState<"passphrase" | "passkey">("passphrase");

  async function runPasskeyStep() {
    setBusy(true);
    setErr(null);
    try {
      await passkeyLogin();
      // Success: re-check status rather than assume - the server's own verdict
      // (the REAL session cookie now riding) is what unlocks the app.
      setAuthStatus(await api.getAuthStatus());
    } catch (e) {
      // The copy rule, always - one generic line per verdict; never the server
      // body, never the browser exception text. The pending window (5 min)
      // allows a retry on the same passphrase step.
      setErr(passkeyErrorMessage(e instanceof PasskeyStepError ? e.status : null));
    } finally {
      setBusy(false);
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy || !passphrase) return;
    setBusy(true);
    setErr(null);
    try {
      const res = await api.login(passphrase);
      if (!res.ok) {
        // One generic line per the copy rule - never the server's error detail.
        setErr(loginErrorMessage(res.status));
        return;
      }
      // SIM-394: an ENFORCED instance (flag on, >=2 passkeys) answers
      // { ok:true, webauthnRequired:true } and sets only the short-lived
      // pending cookie - the session is still owed a passkey assertion. Flag
      // off / enrollment mode answers { ok:true } and this branch never runs.
      const body = (await res.json().catch(() => ({}))) as { webauthnRequired?: boolean };
      if (body.webauthnRequired) {
        setPassphrase("");
        setStep("passkey");
        void runPasskeyStep(); // fire the browser prompt right away
        return;
      }
      // Success: re-check status rather than assume - the server's own verdict
      // (cookie now riding) is what unlocks the app.
      setAuthStatus(await api.getAuthStatus());
    } catch {
      setErr(loginErrorMessage(null));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex h-full items-center justify-center px-4">
      <form
        onSubmit={submit}
        className="w-full max-w-[360px] rounded-xl border border-[var(--color-edge)] bg-[var(--color-panel)] p-6"
      >
        <div className="flex items-center gap-2">
          <div className="flex h-7 w-7 items-center justify-center rounded-md bg-[var(--color-accent)] text-[15px] font-bold text-white">
            J
          </div>
          <div className="text-[14px] font-semibold text-[var(--color-text)]">
            Jobhunt Command Center
          </div>
        </div>
        <div className="mt-4 font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--color-muted)]">
          Private instance · Session required
        </div>
        {step === "passphrase" ? (
          <>
            <label
              htmlFor="login-passphrase"
              className="mt-4 block text-[11px] font-semibold uppercase tracking-wide text-[var(--color-muted)]"
            >
              Passphrase
            </label>
            <input
              id="login-passphrase"
              type="password"
              autoFocus
              autoComplete="current-password"
              value={passphrase}
              onChange={(e) => setPassphrase(e.target.value)}
              className="mt-1.5 min-h-[44px] w-full rounded-md border border-[var(--color-edge)] bg-[var(--color-panel-2)] px-3 py-2 text-[13px] text-[var(--color-text)] outline-none focus:border-[var(--color-accent)] sm:min-h-0"
            />
            {/* The one feedback line: reserved height so the card never jumps;
                role=alert so the verdict is announced. */}
            <div role="alert" className="mt-2 min-h-[18px] text-[12px] text-rose-400">
              {err}
            </div>
            <button
              type="submit"
              disabled={busy || !passphrase}
              className="mt-2 flex min-h-[44px] w-full items-center justify-center rounded-md bg-[var(--color-accent)] px-3 py-2 text-[13px] font-semibold text-white hover:opacity-90 disabled:opacity-40 sm:min-h-[36px]"
            >
              {busy ? "Checking..." : "Unlock"}
            </button>
          </>
        ) : (
          <>
            <div className="mt-4 text-[12px] text-[var(--color-muted)]">
              Passphrase accepted. Confirm with your passkey to finish signing in.
            </div>
            <div role="alert" className="mt-2 min-h-[18px] text-[12px] text-rose-400">
              {err}
            </div>
            <button
              type="button"
              disabled={busy}
              onClick={() => void runPasskeyStep()}
              className="mt-2 flex min-h-[44px] w-full items-center justify-center rounded-md bg-[var(--color-accent)] px-3 py-2 text-[13px] font-semibold text-white hover:opacity-90 disabled:opacity-40 sm:min-h-[36px]"
            >
              {busy ? "Waiting for passkey..." : "Use passkey"}
            </button>
            <button
              type="button"
              className="mt-2 w-full text-center text-[11px] text-[var(--color-muted)] underline"
              onClick={() => {
                setErr(null);
                setStep("passphrase");
              }}
            >
              Start over
            </button>
          </>
        )}
      </form>
    </div>
  );
}
