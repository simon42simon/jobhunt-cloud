import type { IntakeRequest } from "../types";

// Pure selectors for the Intake ledger view (ops F9, t-1783183576744). The
// CTO-session auto-capture hook records machine echoes - background-agent
// <task-notification> completion blobs (and any captured <system-reminder>) -
// as source:"session" rows, drowning the owner's real asks in the ledger.
// Until the hook itself is scoped to skip them (t-1783144206969), the view
// classifies client-side and defaults to owner-initiated rows, with the full
// ledger one click away. Kept DOM-free so it unit-tests node-env style
// (tests/intake.test.ts), the same model as lib/chatbotQueue.ts.

// Markers a machine echo STARTS with. Deliberately narrow (exact leading tag,
// leading-whitespace-tolerant): an owner ask that merely MENTIONS a tag
// mid-text stays owner-initiated - only a verbatim captured system blob has
// one as its very first token. A new echo shape is a one-line addition.
const MACHINE_TEXT_MARKERS = ["<task-notification>", "<system-reminder>"];

// Owner-initiated = an in-app chatbot capture (owner ask by construction), or
// any session prompt that is not a machine blob (typed/pasted owner asks).
export function isOwnerInitiated(req: IntakeRequest): boolean {
  if (req.source === "chatbot") return true;
  const text = req.text.trimStart();
  return !MACHINE_TEXT_MARKERS.some((marker) => text.startsWith(marker));
}

// The default Intake view: the owner's real asks. Preserves input order; does
// not mutate the input array.
export function filterOwnerInitiated(requests: IntakeRequest[]): IntakeRequest[] {
  return requests.filter(isOwnerInitiated);
}
