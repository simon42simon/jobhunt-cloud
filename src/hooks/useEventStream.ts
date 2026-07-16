import { useEffect, useRef, useState } from "react";

// ---------------------------------------------------------------------------
// One shared server-sent-event stream for the whole app (SSE consolidation, UX
// F1). The server (server/index.js broadcast) pushes ONE typed JSON object per
// `data:` frame; historically every consumer either opened its OWN EventSource
// or, worse, ran a poll loop. This module opens a SINGLE module-level
// EventSource, parses each frame into a typed event, and fans it out to
// per-type subscribers - so a dozen components share one connection and refresh
// on a real server signal instead of a timer.
//
// Design notes:
//   - LAZY + SINGLETON: the connection opens on the first subscribe() and there
//     is only ever one (guarded across Vite HMR reloads so a hot-swap does not
//     leak a second socket).
//   - RECONNECT WITH BACKOFF: the browser's EventSource auto-reconnects on a
//     transient blip; when it gives up (readyState CLOSED, e.g. a server bounce)
//     we rebuild it ourselves with exponential backoff.
//   - DOCUMENT-HIDDEN AWARE: we do not burn reconnect attempts while the tab is
//     hidden; regaining visibility reconnects promptly (and resets the backoff).
//   - FAIL-SOFT: a malformed frame is dropped; a throwing subscriber never
//     breaks the fan-out.
// ---------------------------------------------------------------------------

// The typed event vocabulary, in lockstep with server/index.js broadcast().
export interface ServerEventMap {
  "jobs-changed": { type: "jobs-changed" };
  "run-finished": { type: "run-finished"; runId?: string; routine?: string; jobId?: string | null };
  "source-run-finished": { type: "source-run-finished"; sourceId?: string | null };
  // A source's instruction-proposal log changed (filed / approved / rejected) -
  // discovery-sources.yaml lives in docs/, outside the JOBS_DIR watcher, so the
  // server broadcasts this explicitly (DISC-W3). A propose run CLOSING is the
  // ordinary "run-finished" with routine "propose-instructions".
  "source-proposals-changed": { type: "source-proposals-changed"; sourceId?: string | null };
  "tasks-changed": { type: "tasks-changed" };
}
export type ServerEventType = keyof ServerEventMap;
export type ServerEvent = ServerEventMap[ServerEventType];

// Parse one `data:` payload into a typed event. Pure + exported so the parse
// contract is unit-testable without a DOM or a network. Returns null for a
// malformed frame or an object with no string `type` (the server always sets
// one; a torn/legacy frame is dropped rather than dispatched).
export function parseEvent(raw: string): ServerEvent | null {
  try {
    const obj = JSON.parse(raw);
    if (obj && typeof obj === "object" && typeof obj.type === "string") {
      return obj as ServerEvent;
    }
  } catch {
    /* malformed frame - drop it */
  }
  return null;
}

type AnyHandler = (event: ServerEvent) => void;
const subscribers = new Map<string, Set<AnyHandler>>();

// Fan one event out to every subscriber registered for its type. Exported for
// the parse+fan-out unit test; also called by the live connection. Iterates a
// copy so a handler that unsubscribes mid-dispatch cannot mutate the live set,
// and swallows a handler throw so one bad subscriber never sinks the rest.
export function dispatch(event: ServerEvent): void {
  const set = subscribers.get(event.type);
  if (!set) return;
  for (const handler of [...set]) {
    try {
      handler(event);
    } catch {
      /* a subscriber error must not break the fan-out */
    }
  }
}

// Register a typed handler; returns an unsubscribe. Opens the shared connection
// on the first subscriber. Handler identity is the dedupe key, so a caller that
// wants a stable subscription should pass a stable function (the useEventSubscription
// hook below does this for React components).
export function subscribe<T extends ServerEventType>(
  type: T,
  handler: (event: ServerEventMap[T]) => void,
): () => void {
  let set = subscribers.get(type);
  if (!set) {
    set = new Set();
    subscribers.set(type, set);
  }
  set.add(handler as AnyHandler);
  ensureConnected();
  return () => {
    const current = subscribers.get(type);
    if (!current) return;
    current.delete(handler as AnyHandler);
    if (current.size === 0) subscribers.delete(type);
  };
}

// --- the single live connection -------------------------------------------

// Are we in a real browser with EventSource? Guards every transport touch so
// the module can be imported in a node/test env without opening a socket or a
// timer (subscribe/dispatch/parseEvent stay usable for pure-logic tests).
const IN_BROWSER = typeof window !== "undefined" && typeof EventSource !== "undefined";

const BACKOFF_MIN_MS = 1000;
const BACKOFF_MAX_MS = 30000;

let source: EventSource | null = null;
let reconnectTimer: number | null = null;
let backoffMs = 0;
let visibilityWired = false;

function ensureConnected(): void {
  if (!IN_BROWSER || source) return;
  wireVisibility();
  connect();
}

function connect(): void {
  if (!IN_BROWSER || source) return;
  clearReconnect();
  try {
    source = new EventSource("/api/stream");
  } catch {
    source = null;
    scheduleReconnect();
    return;
  }
  source.onopen = () => {
    backoffMs = 0; // a clean open resets the backoff ladder
  };
  source.onmessage = (e) => {
    const event = parseEvent(e.data);
    if (event) dispatch(event);
  };
  source.onerror = () => {
    // The browser keeps EventSource in CONNECTING and retries on a transient
    // blip - leave that alone. Only when it has fully given up (CLOSED) do we
    // tear down and rebuild with our own backoff.
    if (source && source.readyState === EventSource.CLOSED) {
      source.close();
      source = null;
      scheduleReconnect();
    }
  };
}

function scheduleReconnect(): void {
  if (!IN_BROWSER || reconnectTimer !== null || source) return;
  if (subscribers.size === 0) return; // nothing to feed - stay disconnected
  // Do not spend reconnect attempts while hidden; visibilitychange kicks it.
  if (typeof document !== "undefined" && document.hidden) return;
  backoffMs = backoffMs ? Math.min(backoffMs * 2, BACKOFF_MAX_MS) : BACKOFF_MIN_MS;
  reconnectTimer = window.setTimeout(() => {
    reconnectTimer = null;
    if (!source && subscribers.size > 0) connect();
  }, backoffMs);
}

function clearReconnect(): void {
  if (reconnectTimer !== null) {
    window.clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

function onVisibilityChange(): void {
  if (typeof document === "undefined" || document.hidden) return;
  // Back in the foreground: if the stream dropped while hidden, reconnect now
  // with a fresh backoff so the resume is snappy.
  if (!source && subscribers.size > 0) {
    backoffMs = 0;
    clearReconnect();
    connect();
  }
}

function wireVisibility(): void {
  if (visibilityWired || !IN_BROWSER || typeof document === "undefined") return;
  visibilityWired = true;
  document.addEventListener("visibilitychange", onVisibilityChange);
}

// Vite HMR guard: on a hot module replacement, close the live socket + timers so
// the re-evaluated module opens exactly one fresh connection instead of leaking
// a second. `import.meta.hot` is dev-only; typed loosely so this file needs no
// vite/client ambient types.
const viteHot = (import.meta as unknown as { hot?: { dispose(cb: () => void): void } }).hot;
if (viteHot) {
  viteHot.dispose(() => {
    if (source) {
      source.close();
      source = null;
    }
    clearReconnect();
    if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onVisibilityChange);
    visibilityWired = false;
    subscribers.clear();
  });
}

// --- React ergonomics ------------------------------------------------------

// Subscribe a component to a typed event for its lifetime. The handler is held
// in a ref so a caller can pass an inline arrow without churning the
// subscription every render - we subscribe once per `type` and always invoke
// the latest handler.
export function useEventSubscription<T extends ServerEventType>(
  type: T,
  handler: (event: ServerEventMap[T]) => void,
): void {
  const handlerRef = useRef(handler);
  useEffect(() => {
    handlerRef.current = handler;
  }, [handler]);
  useEffect(() => subscribe(type, (event) => handlerRef.current(event)), [type]);
}

// Track document visibility as React state, so a consumer can pause background
// work entirely while the tab is hidden (and resume on return). Defaults to
// visible in a non-DOM env.
export function useDocumentVisible(): boolean {
  const [visible, setVisible] = useState(() => typeof document === "undefined" || !document.hidden);
  useEffect(() => {
    if (typeof document === "undefined") return;
    const onChange = () => setVisible(!document.hidden);
    document.addEventListener("visibilitychange", onChange);
    return () => document.removeEventListener("visibilitychange", onChange);
  }, []);
  return visible;
}
