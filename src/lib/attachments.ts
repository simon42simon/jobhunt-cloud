import type { TaskAttachment } from "../types";

// ---------------------------------------------------------------------------
// Pasted-image ticket attachments (ADR-014), CLIENT side. Two pure, DOM-free
// seams behind ChatCapture's image-paste feature, kept here so they unit-test
// node-env style (no React render layer exists in this project - see
// tests/chatbotQueue.test.ts):
//   1. classify/validate a batch of dropped/pasted files (planFileIngest) +
//      compose one friendly note (ingestNote), and
//   2. the fail-soft upload orchestration (uploadPendingImages).
//
// These caps + the allowlist MIRROR the server (server/lib.js MIME_ALLOWLIST /
// JOBHUNT_ATTACH_MAX_BYTES / _MAX_COUNT) so the compose box can reject an
// obviously-bad file INSTANTLY with friendly copy instead of a round-trip and an
// error. The SERVER stays authoritative (magic-byte sniff, byte cap, per-ticket
// count, de-dupe) - a value that slips past these still gets caught there.
// ---------------------------------------------------------------------------

export const IMAGE_MIME_ALLOWLIST = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;
export type AllowedImageMime = (typeof IMAGE_MIME_ALLOWLIST)[number];
const ALLOWED = new Set<string>(IMAGE_MIME_ALLOWLIST);

export const MAX_ATTACHMENT_MB = 5;
export const MAX_ATTACHMENT_BYTES = MAX_ATTACHMENT_MB * 1024 * 1024; // 5 MB
export const MAX_ATTACHMENTS_PER_TICKET = 6;

export function isImageType(type: string): boolean {
  return typeof type === "string" && type.toLowerCase().startsWith("image/");
}

export function isAllowedImageType(type: string): boolean {
  return typeof type === "string" && ALLOWED.has(type.toLowerCase());
}

// Text-ish files are ingested into the report as text (existing behavior);
// everything else is a binary we do NOT upload - EXCEPT an allowlisted image,
// which now becomes a pending attachment. Moved here from ChatCapture so the
// whole file-classification decision lives in one pure, tested place.
const TEXT_FILE_EXT = /\.(md|markdown|txt|text|json|csv|tsv|log|ya?ml)$/i;

// Metadata-only view of a File (name/type/size) so the classifier stays DOM-free
// and unit-testable without a real File/Blob.
export interface FileMeta {
  name: string;
  type: string;
  size: number;
}

export function isTextIshFile(meta: FileMeta): boolean {
  const type = (meta.type || "").toLowerCase();
  if (type.startsWith("text/")) return true;
  if (type === "application/json" || type === "text/csv") return true;
  // Some OSes report no MIME for .md/.log/etc; fall back to the extension.
  return !meta.type && TEXT_FILE_EXT.test(meta.name);
}

// A friendly display label for an attachment. A pasted screenshot arrives with
// no filename, so we synthesize "pasted image.<ext>" (matching the server's own
// default); a dropped file keeps its own name.
export function imageDisplayName(meta: { name: string; type: string }): string {
  const trimmed = (meta.name || "").trim();
  if (trimmed) return trimmed;
  const sub = (meta.type || "").toLowerCase().split("/")[1] || "png";
  const ext = sub === "jpeg" ? "jpg" : sub;
  return `pasted image.${ext}`;
}

// The pure decision for a batch of dropped/pasted files given how many
// attachment slots remain (MAX_ATTACHMENTS_PER_TICKET minus the images already
// pending). Returns INDICES into the input (the caller maps them back to the
// real File objects, since File is a DOM type) plus the display names of
// everything skipped, bucketed by reason so the caller can compose one note.
// Never mutates its input and does no IO.
export interface FileIngestPlan {
  text: number[]; // text-ish files -> ingest as report text
  images: number[]; // allowlisted images within caps -> pending attachments
  skippedBinaries: string[]; // non-image, non-text binaries: named, not uploaded
  rejectedType: string[]; // image/* but not allowlisted (e.g. SVG), or a bogus image type
  rejectedSize: string[]; // allowlisted images over the 5 MB cap
  rejectedCount: number; // allowlisted, in-size images dropped by the per-ticket cap
}

export function planFileIngest(files: FileMeta[], remainingSlots: number): FileIngestPlan {
  const plan: FileIngestPlan = {
    text: [],
    images: [],
    skippedBinaries: [],
    rejectedType: [],
    rejectedSize: [],
    rejectedCount: 0,
  };
  let slots = Math.max(0, remainingSlots);
  files.forEach((file, i) => {
    if (isTextIshFile(file)) {
      plan.text.push(i);
      return;
    }
    if (isImageType(file.type)) {
      if (!isAllowedImageType(file.type)) {
        plan.rejectedType.push(file.name);
      } else if (file.size > MAX_ATTACHMENT_BYTES) {
        plan.rejectedSize.push(file.name);
      } else if (slots <= 0) {
        plan.rejectedCount += 1;
      } else {
        plan.images.push(i);
        slots -= 1;
      }
      return;
    }
    plan.skippedBinaries.push(file.name);
  });
  return plan;
}

function names(list: string[]): string {
  return list.filter(Boolean).join(", ");
}

// One friendly inline note summarizing everything the plan did NOT accept as a
// pending image or ingest as text. Returns null when there is nothing to report
// (a clean batch of images/text). `extraSkipped` folds in files the CALLER
// failed to read (an IO failure the pure planner can't know about).
export function ingestNote(plan: FileIngestPlan, extraSkipped: string[] = []): string | null {
  const parts: string[] = [];
  if (plan.rejectedType.length) {
    parts.push(`${names(plan.rejectedType)} - only PNG, JPEG, GIF, or WebP images can be attached.`);
  }
  if (plan.rejectedSize.length) {
    const many = plan.rejectedSize.length > 1;
    parts.push(`${names(plan.rejectedSize)} ${many ? "are" : "is"} over ${MAX_ATTACHMENT_MB} MB, so ${many ? "they were" : "it was"} not attached.`);
  }
  if (plan.rejectedCount > 0) {
    parts.push(`You can attach up to ${MAX_ATTACHMENTS_PER_TICKET} images per report.`);
  }
  const skipped = [...plan.skippedBinaries, ...extraSkipped];
  if (skipped.length) {
    parts.push(`Skipped ${names(skipped)} - this box captures text and images, so nothing else was uploaded.`);
  }
  return parts.length ? parts.join(" ") : null;
}

// ---------------------------------------------------------------------------
// Upload orchestration (fail-soft).
// ---------------------------------------------------------------------------

export interface PendingImageUpload {
  blob: Blob;
  name: string;
}

export interface AttachmentUploadOutcome {
  uploaded: number;
  failed: number;
}

// Upload each pending image to the ticket, SEQUENTIALLY and FAIL-SOFT. The
// caller (ChatCapture.queueTicket) has ALREADY filed the ticket before this
// runs, so this must NEVER reject: a per-image rejection (network, or the
// server's 413/415/409) is COUNTED, not thrown, and the loop continues to the
// next image. Sequential (not Promise.all) so the server's 6-per-ticket count
// check sees a deterministic order and we never fire a burst. Returns how many
// landed vs. failed so the caller can surface a single soft note and keep the
// ticket filed regardless - mirroring the best-effort posture of the
// assess-ticket call and the D1 intake write.
export async function uploadPendingImages(
  taskId: string,
  images: PendingImageUpload[],
  upload: (taskId: string, blob: Blob, name: string) => Promise<TaskAttachment>,
): Promise<AttachmentUploadOutcome> {
  let uploaded = 0;
  let failed = 0;
  for (const img of images) {
    try {
      await upload(taskId, img.blob, img.name);
      uploaded += 1;
    } catch {
      failed += 1;
    }
  }
  return { uploaded, failed };
}
