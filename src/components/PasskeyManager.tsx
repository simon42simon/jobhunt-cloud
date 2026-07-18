// SIM-394 - the passkey enrollment surface (only mounted when the server
// reports the WebAuthn flag ON). Lists registered passkeys with label +
// created date, adds a new one (label -> register ceremony), and deletes by id
// with the LAST-CREDENTIAL GUARD mirrored client-side: the delete button is
// disabled at 1 remaining credential, matching the server's 409 refusal
// (server/webauthn.js) - the anti-lockout rule is enforced server-side; this
// mirror just keeps the UI honest about it.
//
// Error copy here is the SERVER's own message (e.g. the 409 last-passkey line):
// this surface sits behind a live session, so the lines are owner guidance,
// not credential verdicts - the login gate's generic-copy rule applies to the
// login lane only (lib/authSession passkeyErrorMessage).

import { useCallback, useEffect, useState } from "react";
import { addPasskey, deletePasskey, listPasskeys, type PasskeyList } from "../lib/passkeys";

const panelCls =
  "w-full max-w-md rounded-lg border border-[var(--color-edge)] bg-[var(--color-panel)] p-5 shadow-xl";
const btnCls =
  "rounded border border-[var(--color-edge)] px-3 py-1.5 text-[12px] hover:bg-[var(--color-edge)] disabled:cursor-not-allowed disabled:opacity-40";

export function PasskeyManager({ onClose }: { onClose: () => void }) {
  const [list, setList] = useState<PasskeyList | null>(null);
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setList(await listPasskeys());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const onAdd = async () => {
    setBusy(true);
    setError(null);
    try {
      await addPasskey(label.trim() || "passkey");
      setLabel("");
      await refresh();
    } catch (e) {
      // A user-cancelled browser prompt lands here too - surfaced, not fatal.
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const onDelete = async (id: string, credLabel: string) => {
    if (!window.confirm(`Remove passkey "${credLabel}"?`)) return;
    setBusy(true);
    setError(null);
    try {
      await deletePasskey(id);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const creds = list?.credentials ?? [];
  // Client-side mirror of the server's last-credential refusal (409).
  const lastCredentialLocked = creds.length <= 1;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Passkey manager"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className={panelCls}>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-[14px] font-semibold">Passkeys (second factor)</h2>
          <button type="button" className={btnCls} onClick={onClose}>
            Close
          </button>
        </div>

        {list && (
          <p className="mb-3 text-[12px] text-[var(--color-muted)]">
            {list.enforced
              ? "Enforced: login requires the passphrase AND a passkey."
              : `Enrollment mode: register at least ${list.minCredentials} passkeys (ideally on different devices) to arm enforcement. Passphrase-only login still works until then.`}
          </p>
        )}

        <ul className="mb-4 space-y-2">
          {creds.map((c) => (
            <li
              key={c.id}
              className="flex items-center justify-between rounded border border-[var(--color-edge)] px-3 py-2 text-[13px]"
            >
              <span>
                <span className="font-medium">{c.label}</span>
                <span className="ml-2 text-[11px] text-[var(--color-muted)]">
                  added {c.created ? new Date(c.created).toLocaleDateString() : "-"}
                </span>
              </span>
              <button
                type="button"
                className={btnCls}
                disabled={busy || lastCredentialLocked}
                title={
                  lastCredentialLocked
                    ? "The last passkey cannot be removed while the second factor is on (anti-lockout). Add another first."
                    : "Remove this passkey"
                }
                onClick={() => void onDelete(c.id, c.label)}
              >
                Remove
              </button>
            </li>
          ))}
          {list && creds.length === 0 && (
            <li className="text-[12px] text-[var(--color-muted)]">No passkeys registered yet.</li>
          )}
        </ul>

        <div className="flex gap-2">
          <input
            type="text"
            value={label}
            maxLength={64}
            placeholder='Label (e.g. "laptop-touchid")'
            className="min-w-0 flex-1 rounded border border-[var(--color-edge)] bg-transparent px-2 py-1.5 text-[13px]"
            onChange={(e) => setLabel(e.target.value)}
            disabled={busy}
          />
          <button type="button" className={btnCls} disabled={busy} onClick={() => void onAdd()}>
            {busy ? "Working..." : "Add passkey"}
          </button>
        </div>

        {error && (
          <p role="alert" className="mt-3 text-[12px] text-rose-400">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}
