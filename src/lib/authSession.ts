import { useSyncExternalStore } from "react";

// Client-side session state for the feature-flagged app auth (SIM-391; server
// side is server/auth.js, ADR-024). A tiny external store in the lib/router.ts
// mold: LoginGate writes it from GET /api/auth/status, the TopBar's Log out
// affordance reads it, and the api layer flips it on any mid-session 401 so an
// expired cookie lands the owner back on the gate instead of a dead board.
// Pure module state + a hook - no context, no new dependencies.

// SIM-394: the status body's optional webauthn block (present only when the
// server's JOBHUNT_WEBAUTHN flag is ON - flag off keeps the body byte-identical
// to the pre-SIM-394 shape, so this stays optional forever).
export interface WebauthnStatus {
  enabled: boolean;
  enforced: boolean;
  enrolling: boolean;
}

export interface AuthStatus {
  authRequired: boolean;
  authenticated: boolean;
  webauthn?: WebauthnStatus;
}

// null = not probed yet (LoginGate holds all rendering until the first probe
// answers, so no data fetch can ever race ahead of the gate).
let status: AuthStatus | null = null;

type Listener = () => void;
const listeners = new Set<Listener>();

function emit(): void {
  for (const l of [...listeners]) {
    try {
      l();
    } catch {
      /* one bad subscriber must not break the fan-out */
    }
  }
}

export function getAuthStatus(): AuthStatus | null {
  return status;
}

function sameWebauthn(a: WebauthnStatus | undefined, b: WebauthnStatus | undefined): boolean {
  if (!a && !b) return true;
  return !!a && !!b && a.enabled === b.enabled && a.enforced === b.enforced && a.enrolling === b.enrolling;
}

export function setAuthStatus(next: AuthStatus): void {
  if (
    status &&
    status.authRequired === next.authRequired &&
    status.authenticated === next.authenticated &&
    sameWebauthn(status.webauthn, next.webauthn)
  ) {
    return; // no change - never churn subscribers
  }
  status = next;
  emit();
}

// Any /api response that comes back 401 means the session cookie is gone or
// expired (an auth-OFF server never 401s - its gate is not mounted - so this
// can only fire on the auth-walled instance). Flip straight to the gate.
// api.ts json() calls this; the login route's own credential-verdict 401
// deliberately does NOT go through json(), so a wrong passphrase never loops.
export function notifyUnauthorized(): void {
  setAuthStatus({ authRequired: true, authenticated: false });
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function snapshot(): AuthStatus | null {
  return status;
}

// The current auth state as React state (stable object reference between
// writes, so useSyncExternalStore never sees snapshot churn).
export function useAuthStatus(): AuthStatus | null {
  return useSyncExternalStore(subscribe, snapshot);
}

// The gate's whole error vocabulary, as one pure rule (unit-tested): a wrong
// passphrase gets ONE generic line - no hint which part was wrong, no server
// detail passthrough; the server's rate limiter (10/15min) surfaces as its own
// honest line; anything else (server unreachable, 5xx) is a transport problem,
// not a credential verdict.
export function loginErrorMessage(httpStatus: number | null): string {
  if (httpStatus === 429) return "Too many attempts - wait a few minutes.";
  if (httpStatus === 401) return "Passphrase not accepted.";
  return "Could not reach the server - try again.";
}

// SIM-394: the passkey step's copy rule - the SAME generic-error contract as
// loginErrorMessage, extended to the second factor. The server's assertion lane
// answers ONE uniform 401 for every failure class (unknown credential, expired
// challenge, bad signature - server/webauthn.js denyAssertion), and this rule
// keeps the client just as quiet: one generic line per verdict, never server
// detail, never the browser's own exception text (a DOMException can name the
// authenticator). 429 is the login limiter (the assertion lane shares its knobs).
export function passkeyErrorMessage(httpStatus: number | null): string {
  if (httpStatus === 429) return "Too many attempts - wait a few minutes.";
  if (httpStatus === 401) return "Passkey not accepted - try again.";
  return "Passkey step did not complete - try again.";
}

// Test seam: reset module state between unit tests. Never called by app code.
export function resetAuthForTests(): void {
  status = null;
  listeners.clear();
}
