import { useEffect, useState } from "react";
import { api } from "../api";
import { loginErrorMessage, setAuthStatus, useAuthStatus } from "../lib/authSession";

// The login gate for the auth-walled private instance (SIM-391; server side is
// server/auth.js, ADR-024). Wraps the WHOLE app in main.tsx, so the boot order
// is structural, not conventional: GET /api/auth/status is the only request
// that can fire before the gate passes - App (and every data hook in it) mounts
// only once auth is off or the session is live, and unmounts again if a
// mid-session 401 flips the store (lib/authSession). Auth OFF - the laptop dev
// posture and the public demo - renders children unchanged: the status probe
// 404s there (an auth-off server registers no /api/auth/* routes) and maps to
// { authRequired:false }, byte-identical behavior to before this gate existed.
export function LoginGate({ children }: { children: React.ReactNode }) {
  const status = useAuthStatus();

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
  return <>{children}</>;
}

// The centered login card - the ONLY thing on screen while locked (no app
// chrome, nothing to probe). Calm system-readout voice: this is the owner's
// private instance stating a fact, not a marketing page.
function LoginCard() {
  const [passphrase, setPassphrase] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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
      </form>
    </div>
  );
}
