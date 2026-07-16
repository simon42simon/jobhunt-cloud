import { useEffect } from "react";

// ---------------------------------------------------------------------------
// Usage-journey telemetry client (ADR-017, Wave 2). A tiny, fail-soft beacon
// that records the OWNER'S movements in the app - which surfaces they open,
// which actions they take, which routines they run - so a later insights
// routine can learn from real usage instead of inferring it.
//
// EVENTS, NEVER CONTENT. An event carries a closed `kind`, a closed `surface`
// id, and a bounded `name` (a view / button / saved-view id) plus an optional
// scalar-only `meta`. It NEVER carries a job title, note body, keystroke, URL,
// or any free text the user typed. The server (POST /api/telemetry) is the
// authority - it re-enforces the enum + allowlist + length caps + a scalar-only
// meta block; this client mirrors those bounds as a first line of defence so a
// malformed call can never smuggle content off the page.
//
// FAIL-SOFT IS THE PRIME DIRECTIVE. Every entry point is wrapped in try/catch:
// a telemetry failure drops the event and returns, it never throws, never
// retries in a loop, never blocks a user action, and emits no console noise.
// ---------------------------------------------------------------------------

// Closed enums / caps MIRRORED from server/index.js (the exported
// TELEMETRY_KINDS / TELEMETRY_SURFACES / TELEMETRY_MAX_BATCH). We deliberately
// re-declare them here rather than import server code across the lane boundary;
// the server stays authoritative and re-validates every event. Keep this list
// in lockstep with the server's allowlist.
export type TelemetryKind = "view" | "action" | "run";

export type TelemetrySurface =
  | "jobs-board"
  | "jobs-table"
  | "job-detail"
  | "discovery-sources"
  | "discovery-finds"
  | "source-detail"
  | "insights"
  | "product-hub"
  | "chat-capture"
  | "notifications"
  | "topbar";

export const TELEMETRY_SURFACES: readonly TelemetrySurface[] = [
  "jobs-board",
  "jobs-table",
  "job-detail",
  "discovery-sources",
  "discovery-finds",
  "source-detail",
  "insights",
  "product-hub",
  "chat-capture",
  "notifications",
  "topbar",
];

// The ten canonical user journeys (docs/user-journeys.md). A typed union so a
// call site cannot mistype the id; the server also gates journey on /^J\d{1,2}$/.
export type Journey = "J1" | "J2" | "J3" | "J4" | "J5" | "J6" | "J7" | "J8" | "J9" | "J10" | "J12";

// Meta is intentionally SCALAR-ONLY - no nested object/array can ride along, so
// no document can be smuggled through it. Values are short stable ids/enums or
// numbers (e.g. { to: "submitted", via: "drag" }), never user-typed content.
export type TelemetryMetaValue = string | number | boolean;

export interface TelemetryExtra {
  journey?: Journey;
  meta?: Record<string, TelemetryMetaValue>;
  durationMs?: number;
}

export interface TelemetryEvent {
  sessionId: string;
  kind: TelemetryKind;
  surface: TelemetrySurface;
  name: string;
  journey?: Journey;
  meta?: Record<string, TelemetryMetaValue>;
  durationMs?: number;
}

// Caps mirror the server (TELEMETRY_* constants). Client-side capping keeps the
// payload small and is a belt-and-suspenders content-block; the server truncates
// again on receipt.
export const TELEMETRY_MAX_BATCH = 50; // per-request event cap (server-enforced)
const NAME_MAX = 80;
const SESSION_MAX = 40;
const META_MAX_KEYS = 8;
const META_KEY_MAX = 40;
const META_VAL_MAX = 60;
const JOURNEY_RE = /^J\d{1,2}$/;

const ENDPOINT = "/api/telemetry";
const FLUSH_INTERVAL_MS = 15000; // periodic drain while the tab is open
const FLUSH_AT = 40; // eager flush threshold, kept below the 50 batch cap
const VIEW_DEDUPE_MS = 2000; // collapse rapid remounts of the same surface

// Are we in a real browser? Guards every DOM/transport touch so the module can
// be imported in a node/test env (or SSR) without throwing or opening timers.
const IN_BROWSER = typeof window !== "undefined" && typeof document !== "undefined";

// Strip all control characters (Unicode category Cc: C0, DEL, and C1) then
// collapse whitespace and trim - mirrors the server scrubTelemetryText so the
// two agree on what a clean id is (no keystrokes, newlines, or control
// sequences ride inside a bounded id).
function scrub(s: string): string {
  return String(s ?? "")
    .replace(/\p{Cc}/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

// Coerce a caller `meta` into a bounded scalar map: at most 8 keys, keys +
// string values length-capped and scrubbed, non-finite numbers and any
// non-scalar value dropped. Returns undefined when nothing survives (so no empty
// meta:{} is ever sent). Mirrors the server's coerceTelemetryMeta.
function coerceMeta(v: TelemetryExtra["meta"]): Record<string, TelemetryMetaValue> | undefined {
  if (!v || typeof v !== "object") return undefined;
  const out: Record<string, TelemetryMetaValue> = {};
  let n = 0;
  for (const rawKey of Object.keys(v)) {
    if (n >= META_MAX_KEYS) break;
    const key = scrub(rawKey).slice(0, META_KEY_MAX);
    if (!key) continue;
    const val = v[rawKey];
    let clean: TelemetryMetaValue | undefined;
    if (typeof val === "string") clean = scrub(val).slice(0, META_VAL_MAX);
    else if (typeof val === "number") clean = Number.isFinite(val) ? val : undefined;
    else if (typeof val === "boolean") clean = val;
    if (clean === undefined || clean === "") continue;
    out[key] = clean;
    n++;
  }
  return Object.keys(out).length ? out : undefined;
}

// Pure builder: normalize one call into the stored event shape, applying every
// client-side cap. Exported so the caps + content-block are unit-testable without
// a DOM or a network. Returns null when the name scrubs to empty (an event the
// server would soft-drop anyway).
export function buildTelemetryEvent(
  sessionId: string,
  kind: TelemetryKind,
  surface: TelemetrySurface,
  name: string,
  extra?: TelemetryExtra,
): TelemetryEvent | null {
  const cleanName = scrub(name).slice(0, NAME_MAX);
  if (!cleanName) return null;
  const event: TelemetryEvent = {
    sessionId: scrub(sessionId).slice(0, SESSION_MAX),
    kind,
    surface,
    name: cleanName,
  };
  if (extra?.journey && JOURNEY_RE.test(extra.journey)) event.journey = extra.journey;
  const meta = coerceMeta(extra?.meta);
  if (meta) event.meta = meta;
  if (typeof extra?.durationMs === "number" && Number.isFinite(extra.durationMs) && extra.durationMs >= 0) {
    event.durationMs = extra.durationMs;
  }
  return event;
}

function makeSessionId(): string {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
  } catch {
    /* fall through to the cheap fallback */
  }
  return `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

// One stable session id per page load (module-level, never persisted).
const SESSION_ID = makeSessionId();

// The in-memory outbox. Bounded in practice by the eager FLUSH_AT drain.
const queue: TelemetryEvent[] = [];

// Send up to one batch (<= cap). Prefer sendBeacon so events survive an unload;
// fall back to fetch(keepalive). Any failure drops the batch - no retry loop.
function flush(): void {
  try {
    if (queue.length === 0) return;
    if (!IN_BROWSER || typeof navigator === "undefined") {
      queue.length = 0; // no transport (test/SSR) - drop, never grow unbounded
      return;
    }
    const batch = queue.splice(0, TELEMETRY_MAX_BATCH);
    const body = JSON.stringify({ events: batch });

    let sent = false;
    try {
      if (typeof navigator.sendBeacon === "function") {
        sent = navigator.sendBeacon(ENDPOINT, new Blob([body], { type: "application/json" }));
      }
    } catch {
      sent = false;
    }
    if (sent) return;

    try {
      void fetch(ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        keepalive: true,
        credentials: "same-origin",
      }).catch(() => {
        /* fire-and-forget: a dropped beacon is acceptable, never retried */
      });
    } catch {
      /* transport unavailable - drop the batch */
    }
  } catch {
    /* a telemetry flush must never throw into the app */
  }
}

let started = false;
// Wire the periodic drain + unload flushes exactly once. visibilitychange
// (hidden) and pagehide are the reliable "the user is leaving" signals; the
// interval covers a long-lived open tab.
function ensureStarted(): void {
  if (started || !IN_BROWSER) return;
  started = true;
  try {
    window.setInterval(() => {
      if (queue.length) flush();
    }, FLUSH_INTERVAL_MS);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") flush();
    });
    window.addEventListener("pagehide", () => flush());
  } catch {
    /* listeners best-effort - telemetry still queues, just flushes less often */
  }
}

// The one entry point. Fire-and-forget: enqueue a normalized event and drain
// eagerly near the cap. Wrapped so a bad call can never break a user action.
export function track(
  kind: TelemetryKind,
  surface: TelemetrySurface,
  name: string,
  extra?: TelemetryExtra,
): void {
  try {
    const event = buildTelemetryEvent(SESSION_ID, kind, surface, name, extra);
    if (!event) return;
    queue.push(event);
    ensureStarted();
    if (queue.length >= FLUSH_AT) flush();
  } catch {
    /* fail-soft: drop the event, never throw, never block the caller */
  }
}

// Rapid remounts (e.g. React StrictMode's double-invoke, or a fast reopen) of
// the same surface collapse into one view within this window.
const lastViewAt: Record<string, number> = {};

// Fire exactly one `view` event when a surface mounts. The dedupe key is the
// surface, so a double-mount inside ~2s counts once.
export function useTrackView(surface: TelemetrySurface, journey?: Journey): void {
  useEffect(() => {
    try {
      const now = Date.now();
      if (now - (lastViewAt[surface] ?? 0) < VIEW_DEDUPE_MS) return;
      lastViewAt[surface] = now;
      track("view", surface, surface, journey ? { journey } : undefined);
    } catch {
      /* fail-soft */
    }
    // journey is a stable literal; surface is the identity of the mount.
  }, [surface, journey]);
}

// Start the drain loop at import time in a browser (idempotent; track() also
// calls this). No-op in a test/SSR env.
ensureStarted();
