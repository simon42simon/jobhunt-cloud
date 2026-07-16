import { describe, it, expect, vi } from "vitest";
import {
  IMAGE_MIME_ALLOWLIST,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS_PER_TICKET,
  imageDisplayName,
  ingestNote,
  isAllowedImageType,
  planFileIngest,
  uploadPendingImages,
  type FileMeta,
  type PendingImageUpload,
} from "../src/lib/attachments";
import type { Task, TaskAttachment } from "../src/types";

// Client-side unit tests for the image-paste feature (ADR-014, Wave B). Node-env
// style (no DOM/React) matching tests/chatbotQueue.test.ts - this project has no
// component-render test layer by design. Two seams under test:
//   1. planFileIngest / ingestNote - the pure accept/validate + note logic that
//      backs ChatCapture.ingestFiles (accept an allowlisted image; reject
//      oversize / wrong-MIME / over the per-ticket count; keep text ingest).
//   2. uploadPendingImages - the fail-soft upload orchestration that
//      ChatCapture.queueTicket fires AFTER the task POST.

const png = (size = 1024): FileMeta => ({ name: "shot.png", type: "image/png", size });

describe("client caps mirror the server contract", () => {
  it("allowlists exactly png/jpeg/gif/webp (no svg) and the 5MB / 6-per-ticket caps", () => {
    expect([...IMAGE_MIME_ALLOWLIST].sort()).toEqual([
      "image/gif",
      "image/jpeg",
      "image/png",
      "image/webp",
    ]);
    expect(isAllowedImageType("image/svg+xml")).toBe(false);
    expect(isAllowedImageType("image/PNG")).toBe(true); // case-insensitive
    expect(MAX_ATTACHMENT_BYTES).toBe(5 * 1024 * 1024);
    expect(MAX_ATTACHMENTS_PER_TICKET).toBe(6);
  });
});

describe("planFileIngest - accept / validate", () => {
  it("accepts an allowlisted image within caps as a pending image", () => {
    const plan = planFileIngest([png()], MAX_ATTACHMENTS_PER_TICKET);
    expect(plan.images).toEqual([0]);
    expect(plan.rejectedType).toEqual([]);
    expect(plan.rejectedSize).toEqual([]);
    expect(plan.rejectedCount).toBe(0);
  });

  it("accepts each allowlisted raster type", () => {
    const files: FileMeta[] = IMAGE_MIME_ALLOWLIST.map((type, i) => ({ name: `f${i}`, type, size: 10 }));
    expect(planFileIngest(files, MAX_ATTACHMENTS_PER_TICKET).images).toEqual([0, 1, 2, 3]);
  });

  it("rejects a wrong-MIME image (SVG is image/* but not allowlisted)", () => {
    const plan = planFileIngest([{ name: "vector.svg", type: "image/svg+xml", size: 10 }], 6);
    expect(plan.images).toEqual([]);
    expect(plan.rejectedType).toEqual(["vector.svg"]);
  });

  it("rejects an image over the 5MB byte cap", () => {
    const plan = planFileIngest([{ name: "huge.png", type: "image/png", size: MAX_ATTACHMENT_BYTES + 1 }], 6);
    expect(plan.images).toEqual([]);
    expect(plan.rejectedSize).toEqual(["huge.png"]);
  });

  it("accepts an image exactly at the byte cap (boundary is inclusive)", () => {
    const plan = planFileIngest([{ name: "edge.png", type: "image/png", size: MAX_ATTACHMENT_BYTES }], 6);
    expect(plan.images).toEqual([0]);
  });

  it("rejects images past the per-ticket count, given remaining slots", () => {
    // 4 valid images, but only 2 slots remain (4 already pending) -> accept 2,
    // count-reject the other 2.
    const files: FileMeta[] = [png(), png(), png(), png()];
    const plan = planFileIngest(files, MAX_ATTACHMENTS_PER_TICKET - 4);
    expect(plan.images).toEqual([0, 1]);
    expect(plan.rejectedCount).toBe(2);
  });

  it("count-rejects everything when zero slots remain", () => {
    const plan = planFileIngest([png(), png()], 0);
    expect(plan.images).toEqual([]);
    expect(plan.rejectedCount).toBe(2);
  });

  it("still ingests text-ish files as text and names a non-image binary", () => {
    const files: FileMeta[] = [
      { name: "notes.md", type: "text/markdown", size: 20 },
      { name: "data.json", type: "application/json", size: 20 },
      { name: "archive.zip", type: "application/zip", size: 20 },
      png(),
    ];
    const plan = planFileIngest(files, 6);
    expect(plan.text).toEqual([0, 1]);
    expect(plan.skippedBinaries).toEqual(["archive.zip"]);
    expect(plan.images).toEqual([3]);
  });

  it("does not mutate its input array", () => {
    const files: FileMeta[] = [png(), png()];
    const snapshot = files.map((f) => f.size);
    planFileIngest(files, 6);
    expect(files.map((f) => f.size)).toEqual(snapshot);
  });
});

describe("ingestNote", () => {
  it("returns null for a clean batch (all accepted as image/text)", () => {
    expect(ingestNote(planFileIngest([png()], 6))).toBeNull();
  });

  it("summarizes rejections in one friendly note", () => {
    const files: FileMeta[] = [
      { name: "vector.svg", type: "image/svg+xml", size: 10 },
      { name: "huge.png", type: "image/png", size: MAX_ATTACHMENT_BYTES + 1 },
      { name: "readme.pdf", type: "application/pdf", size: 10 },
    ];
    const note = ingestNote(planFileIngest(files, 6));
    expect(note).toContain("vector.svg");
    expect(note).toContain("PNG, JPEG, GIF, or WebP");
    expect(note).toContain("huge.png");
    expect(note).toContain("5 MB");
    expect(note).toContain("readme.pdf");
  });

  it("mentions the per-ticket cap when images are count-rejected", () => {
    const note = ingestNote(planFileIngest([png(), png()], 0));
    expect(note).toContain(String(MAX_ATTACHMENTS_PER_TICKET));
  });

  it("folds caller-side unreadable files into the skipped note", () => {
    const note = ingestNote(planFileIngest([], 6), ["locked.txt"]);
    expect(note).toContain("locked.txt");
  });
});

describe("imageDisplayName", () => {
  it("keeps a dropped file's own name", () => {
    expect(imageDisplayName({ name: "Screenshot 2026.png", type: "image/png" })).toBe("Screenshot 2026.png");
  });

  it("synthesizes 'pasted image.<ext>' for a nameless pasted screenshot", () => {
    expect(imageDisplayName({ name: "", type: "image/png" })).toBe("pasted image.png");
    expect(imageDisplayName({ name: "   ", type: "image/jpeg" })).toBe("pasted image.jpg");
    expect(imageDisplayName({ name: "", type: "image/webp" })).toBe("pasted image.webp");
  });
});

// A fabricated server response so the mocked upload has a realistic shape.
function attachment(over: Partial<TaskAttachment> = {}): TaskAttachment {
  return { file: "abc.png", name: "shot.png", mime: "image/png", bytes: 10, ts: "2026-07-04T00:00:00Z", ...over };
}
const blob = (): Blob => new Blob(["x"], { type: "image/png" });
const img = (name: string): PendingImageUpload => ({ blob: blob(), name });

describe("uploadPendingImages - fail-soft orchestration", () => {
  it("uploads every pending image sequentially and reports all landed", async () => {
    const upload = vi.fn(async () => attachment());
    const out = await uploadPendingImages("t-1", [img("a.png"), img("b.png")], upload);
    expect(out).toEqual({ uploaded: 2, failed: 0 });
    expect(upload).toHaveBeenCalledTimes(2);
    expect(upload).toHaveBeenNthCalledWith(1, "t-1", expect.any(Blob), "a.png");
    expect(upload).toHaveBeenNthCalledWith(2, "t-1", expect.any(Blob), "b.png");
  });

  it("is fail-soft: a per-image rejection is COUNTED, never thrown, loop continues", async () => {
    const upload = vi
      .fn<(taskId: string, b: Blob, name: string) => Promise<TaskAttachment>>()
      .mockResolvedValueOnce(attachment({ file: "one.png" }))
      .mockRejectedValueOnce(new Error("413 too large"))
      .mockResolvedValueOnce(attachment({ file: "three.png" }));

    const out = await uploadPendingImages("t-1", [img("1"), img("2"), img("3")], upload);
    expect(out).toEqual({ uploaded: 2, failed: 1 });
  });

  it("total failure resolves (never rejects) with failed === count", async () => {
    const upload = vi.fn(async () => {
      throw new Error("network down");
    });
    await expect(uploadPendingImages("t-1", [img("a"), img("b")], upload)).resolves.toEqual({
      uploaded: 0,
      failed: 2,
    });
  });

  it("no-ops on an empty pending list", async () => {
    const upload = vi.fn(async () => attachment());
    expect(await uploadPendingImages("t-1", [], upload)).toEqual({ uploaded: 0, failed: 0 });
    expect(upload).not.toHaveBeenCalled();
  });
});

// Proves the queueTicket contract at the call-ordering layer WITHOUT a DOM: the
// task POST happens FIRST and its result is returned; the image upload fires
// AFTER, and because uploadPendingImages is fail-soft an upload failure can never
// break task creation. Mirrors ChatCapture.queueTicket exactly (file the task,
// then best-effort attach), the same technique tests/chatbotQueue.test.ts uses
// for the intake-ledger side-write.
describe("file-on-capture ordering: task POST then fail-soft attach", () => {
  async function captureLikeQueueTicket(
    addTask: () => Promise<Task>,
    pending: PendingImageUpload[],
    upload: (taskId: string, b: Blob, name: string) => Promise<TaskAttachment>,
  ): Promise<{ task: Task; failed: number }> {
    const task = await addTask(); // PRIMARY capture - filed first
    const { failed } = await uploadPendingImages(task.id, pending, upload); // AFTER, best-effort
    return { task, failed };
  }

  it("uploads to the id the task POST just returned, after it resolves", async () => {
    const order: string[] = [];
    const addTask = vi.fn(async () => {
      order.push("addTask");
      return { id: "t-900", labels: ["chatbot"] } as Task;
    });
    const upload = vi.fn(async (taskId: string) => {
      order.push(`upload:${taskId}`);
      return attachment();
    });

    const { task, failed } = await captureLikeQueueTicket(addTask, [img("a.png")], upload);

    expect(task.id).toBe("t-900");
    expect(failed).toBe(0);
    expect(order).toEqual(["addTask", "upload:t-900"]); // POST strictly before upload
  });

  it("still returns the filed task when the image upload fails (fail-soft)", async () => {
    const addTask = vi.fn(async () => ({ id: "t-901", labels: ["chatbot"] }) as Task);
    const upload = vi.fn(async () => {
      throw new Error("415 unsupported");
    });

    const { task, failed } = await captureLikeQueueTicket(addTask, [img("a.png")], upload);

    expect(task.id).toBe("t-901"); // the ticket survived the attachment failure
    expect(failed).toBe(1);
    expect(addTask).toHaveBeenCalledTimes(1);
  });
});
