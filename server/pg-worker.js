// RC-3 / SIM-87 I4 - the Postgres worker thread behind the SYNCHRONOUS store seam.
//
// WHY THIS EXISTS (design deviation D1, see server/pg-store.js header): the landed
// Store interface (ADR-025 / I1) is SYNCHRONOUS - route handlers do
// `res.json(store.loadTasks())` and the contract suite asserts on the return value
// with no `await`. `pg` is async. To implement the SAME interface against Postgres
// WITHOUT rewriting every route (out of scope, and contra the "same contract suite,
// zero body changes" DoD), PgStore bridges async->sync: this worker owns the single
// pg Client and runs each query on ITS OWN thread; the main thread blocks on
// Atomics.wait until this worker posts the result back and notifies. Standard
// sync-RPC-over-worker pattern (as used by synckit et al.), hand-rolled here to
// avoid a new runtime dependency.
//
// Parameterized queries ONLY (guardian MF-12): this worker calls client.query(text,
// values) - it NEVER interpolates a value into SQL text.

import { parentPort, workerData } from "node:worker_threads";
import pg from "pg";

const { port, signal } = workerData;
let client = null;

// A bytea parameter crosses the thread boundary as a Uint8Array (structured clone
// drops the Buffer brand); pg wants a Buffer for bytea. Rehydrate any typed-array
// param back to a Buffer so a blob insert binds correctly.
function toParam(v) {
  if (v instanceof Uint8Array && !Buffer.isBuffer(v)) return Buffer.from(v);
  return v;
}

async function handle(p) {
  if (p.op === "connect") {
    client = new pg.Client({ connectionString: p.url });
    await client.connect();
    return true;
  }
  if (p.op === "query") {
    if (!client) throw new Error("pg-worker: query before connect");
    const values = Array.isArray(p.values) ? p.values.map(toParam) : undefined;
    const r = await client.query(p.text, values);
    return { rows: r.rows, rowCount: r.rowCount };
  }
  if (p.op === "end") {
    if (client) {
      await client.end();
      client = null;
    }
    return true;
  }
  throw new Error(`pg-worker: unknown op ${p && p.op}`);
}

port.on("message", async (payload) => {
  let out;
  try {
    out = { ok: true, value: await handle(payload) };
  } catch (e) {
    out = { ok: false, error: { message: String((e && e.message) || e), code: e && e.code } };
  }
  // Post the result FIRST, then flip + notify the shared signal - the main thread
  // is parked in Atomics.wait and drains the port with receiveMessageOnPort the
  // instant it wakes, so the message must already be enqueued.
  port.postMessage(out);
  Atomics.store(signal, 0, 1);
  Atomics.notify(signal, 0);
});

// Keep a hard reference so V8 never GCs the port while the parent is mid-call.
if (parentPort) parentPort.on("message", () => {});
