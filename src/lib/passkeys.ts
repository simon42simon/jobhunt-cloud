// SIM-394 - client half of the feature-flagged WebAuthn/passkey second factor.
//
// RECONCILED into the SIM-391 auth stack (guardian mirror condition M1): unlike
// the dev-repo original, this module does NOT own getAuthStatus/login - those
// stay in src/api.ts + lib/authSession.ts (the one LoginGate). It carries only
// the passkey-specific calls: the login-lane assertion ceremony and the
// session-authed enrollment surface.
//
// All calls are same-origin fetches against the auth-lane endpoints
// (server/auth.js + server/webauthn.js). @simplewebauthn/browser is BUNDLED by
// Vite (a normal npm dependency, hashed into the app's own JS assets), so the
// helmet CSP's script-src 'self' is untouched: no CDN <script>, no eval - the
// library drives the browser-native navigator.credentials API only.
//
// Error posture (the SIM-391 copy rule, extended): every non-OK response throws
// a PasskeyStepError carrying the HTTP status. The LOGIN lane maps it through
// the pure passkeyErrorMessage rule (lib/authSession) - one generic line, no
// server detail, no oracle. The session-authed MANAGER surface shows the
// server's own message (e.g. the last-credential 409 line) - owner-facing
// guidance behind a live session, not a credential verdict. None of these
// fetches ride api.ts json(), so an assertion-lane 401 never trips the global
// back-to-gate hook mid-ceremony (the same reason api.login returns the raw
// Response).

import { startAuthentication, startRegistration } from "@simplewebauthn/browser";

export interface PasskeyMeta {
  id: string;
  label: string;
  created: string | null;
  transports: string[];
}

export interface PasskeyList {
  credentials: PasskeyMeta[];
  enforced: boolean;
  enrolling: boolean;
  minCredentials: number;
}

// A failed passkey-lane HTTP call: `status` feeds the pure copy rule on the
// login gate; `message` (the server's own error line) feeds the session-authed
// manager surface. Browser-ceremony failures (a cancelled prompt, a timeout)
// are NOT this class - they surface as the underlying DOMException and map to
// status null on the gate.
export class PasskeyStepError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "PasskeyStepError";
    this.status = status;
  }
}

async function jsonOrThrow<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new PasskeyStepError(res.status, body.error || `${res.status} ${res.statusText}`);
  }
  return res.json() as Promise<T>;
}

// Step 2 of the two-step login (only when POST /api/auth/login answered
// webauthnRequired): options -> browser prompt -> verify. The pending cookie
// set by the passphrase step authenticates both calls; success swaps it for
// the real session cookie server-side.
export async function passkeyLogin(): Promise<void> {
  const optionsJSON = await jsonOrThrow<Parameters<typeof startAuthentication>[0]["optionsJSON"]>(
    await fetch("/api/webauthn/login/options", { method: "POST", credentials: "same-origin" }),
  );
  const assertion = await startAuthentication({ optionsJSON });
  await jsonOrThrow(
    await fetch("/api/webauthn/login/verify", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ response: assertion }),
    }),
  );
}

// ---- enrollment surface (session-authed) ----------------------------------

export async function listPasskeys(): Promise<PasskeyList> {
  return jsonOrThrow<PasskeyList>(
    await fetch("/api/webauthn/credentials", { credentials: "same-origin" }),
  );
}

export async function addPasskey(label: string): Promise<PasskeyMeta> {
  const optionsJSON = await jsonOrThrow<Parameters<typeof startRegistration>[0]["optionsJSON"]>(
    await fetch("/api/webauthn/register/options", { method: "POST", credentials: "same-origin" }),
  );
  const attestation = await startRegistration({ optionsJSON });
  const out = await jsonOrThrow<{ ok: boolean; credential: PasskeyMeta }>(
    await fetch("/api/webauthn/register/verify", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ response: attestation, label }),
    }),
  );
  return out.credential;
}

export async function deletePasskey(id: string): Promise<void> {
  await jsonOrThrow(
    await fetch(`/api/webauthn/credentials/${encodeURIComponent(id)}`, {
      method: "DELETE",
      credentials: "same-origin",
    }),
  );
}
