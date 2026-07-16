// RC-3 / SIM-87 I4 - synchronous RPC handle to the pg worker (see pg-worker.js for
// the WHY). Exposes a blocking .connect()/.query()/.close() so PgStore can present
// the SAME synchronous interface FileStore does. The main thread parks in
// Atomics.wait; the worker runs the async pg call on its own thread and wakes us.

import { Worker, MessageChannel, receiveMessageOnPort } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import path from "node:path";

const WORKER_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "pg-worker.js");

// Upper bound on how long a single query may block the main thread before we give
// up (a hung worker must never freeze the process forever). Generous: real queries
// against a local cluster are sub-millisecond.
const CALL_TIMEOUT_MS = 30000;

export class SyncPg {
  constructor() {
    this._channel = new MessageChannel();
    this._port = this._channel.port1;
    // 4 bytes over a SharedArrayBuffer: the wake signal Atomics.wait parks on.
    this._signal = new Int32Array(new SharedArrayBuffer(4));
    this._worker = new Worker(WORKER_PATH, {
      workerData: { port: this._channel.port2, signal: this._signal },
      transferList: [this._channel.port2],
    });
    // Do not keep the event loop / process alive on the worker's account.
    this._worker.unref();
    this._closed = false;
  }

  _call(payload) {
    if (this._closed) throw new Error("SyncPg: handle is closed");
    Atomics.store(this._signal, 0, 0);
    this._port.postMessage(payload);
    const r = Atomics.wait(this._signal, 0, 0, CALL_TIMEOUT_MS);
    if (r === "timed-out") throw new Error("SyncPg: query timed out (worker unresponsive)");
    const msg = receiveMessageOnPort(this._port);
    if (!msg) throw new Error("SyncPg: worker signalled but delivered no message");
    const m = msg.message;
    if (!m.ok) {
      const e = new Error(m.error.message);
      if (m.error.code) e.code = m.error.code;
      throw e;
    }
    return m.value;
  }

  connect(url) {
    this._call({ op: "connect", url });
  }

  // Parameterized only: text + bound values. Returns { rows, rowCount }.
  query(text, values) {
    return this._call({ op: "query", text, values });
  }

  close() {
    if (this._closed) return;
    try {
      this._call({ op: "end" });
    } catch {
      /* best-effort: closing a broken handle must never throw */
    }
    this._closed = true;
    try {
      this._port.close();
    } catch {
      /* ignore */
    }
    // terminate() returns a promise; we deliberately do not await it (sync API).
    this._worker.terminate();
  }
}
