import { describe, it, expect } from "vitest";
import {
  applyJobFilter,
  activeConditionCount,
  changeField,
  changeOperator,
  distinctValues,
  isConditionComplete,
  matchCondition,
  newCondition,
  parseFilter,
  serializeFilter,
  type Combinator,
  type Condition,
  type FilterableField,
  type JobFilter,
  type Operator,
} from "../src/lib/jobFilter";
import type { Job, Status } from "../src/types";

// Minimal Job factory (same shape as tests/utils.test.ts): only the fields the
// filter reads are interesting; the rest satisfy the type.
function job(over: Partial<Job> & { status: Status }): Job {
  return {
    id: "j",
    folder: "j",
    folderPath: "/j",
    jobFile: "/j/j.md",
    jobFileName: "j.md",
    role: "Role",
    employer: "Employer",
    track: "t",
    trackLabel: "T",
    fit: "strong",
    rawStatus: over.status,
    sector: "",
    tailoring: "",
    deadline: null,
    applied: null,
    link: "",
    nextAction: "",
    nextActionDate: null,
    tags: [],
    leadWith: "",
    files: [],
    hasCV: false,
    hasCoverLetter: false,
    mtime: 0,
    ...over,
  };
}

let seq = 0;
function cond(field: FilterableField, operator: Operator, value: string | string[] = ""): Condition {
  seq += 1;
  return { id: `t${seq}`, field, operator, value };
}

function filter(combinator: Combinator, conditions: Condition[]): JobFilter {
  return { combinator, conditions };
}

// Convenience: apply a single condition and return the matching ids.
function ids(jobs: Job[], f: JobFilter): string[] {
  return applyJobFilter(jobs, f).map((j) => j.id);
}

describe("applyJobFilter - inert / passthrough", () => {
  it("returns all jobs when there are no conditions", () => {
    const jobs = [job({ id: "a", status: "lead" }), job({ id: "b", status: "offer" })];
    expect(ids(jobs, filter("AND", []))).toEqual(["a", "b"]);
  });

  it("ignores an INCOMPLETE condition (no value) rather than blanking the table", () => {
    const jobs = [job({ id: "a", status: "lead" }), job({ id: "b", status: "offer" })];
    // `is` with an empty value is not yet complete -> filter is inert.
    expect(ids(jobs, filter("AND", [cond("status", "is", "")]))).toEqual(["a", "b"]);
    expect(activeConditionCount(filter("AND", [cond("status", "is", "")]))).toBe(0);
  });
});

describe("enum operators", () => {
  const jobs = [
    job({ id: "lead", status: "lead" }),
    job({ id: "offer", status: "offer" }),
    job({ id: "rej", status: "rejected" }),
  ];

  it("is: exact match only", () => {
    expect(ids(jobs, filter("AND", [cond("status", "is", "offer")]))).toEqual(["offer"]);
  });

  it("is_not: excludes the value, keeps the rest", () => {
    expect(ids(jobs, filter("AND", [cond("status", "is_not", "offer")]))).toEqual(["lead", "rej"]);
  });

  it("is_not: an EMPTY field counts as 'not X' (included)", () => {
    const withBlank = [job({ id: "blank", status: "lead", sector: "" }), job({ id: "pub", status: "lead", sector: "public" })];
    expect(ids(withBlank, filter("AND", [cond("sector", "is_not", "public")]))).toEqual(["blank"]);
  });

  it("is_any_of: matches any listed value", () => {
    expect(ids(jobs, filter("AND", [cond("status", "is_any_of", ["lead", "rejected"])]))).toEqual([
      "lead",
      "rej",
    ]);
  });

  it("is_any_of: an empty option list is incomplete -> inert", () => {
    expect(isConditionComplete(cond("status", "is_any_of", []))).toBe(false);
    expect(ids(jobs, filter("AND", [cond("status", "is_any_of", [])]))).toEqual(["lead", "offer", "rej"]);
  });
});

describe("text operators (case-insensitive)", () => {
  const jobs = [
    job({ id: "acme", status: "lead", employer: "Acme Corp" }),
    job({ id: "beta", status: "lead", employer: "Beta LLC" }),
    job({ id: "blank", status: "lead", employer: "" }),
  ];

  it("contains: case-insensitive substring", () => {
    expect(ids(jobs, filter("AND", [cond("employer", "contains", "acme")]))).toEqual(["acme"]);
    expect(ids(jobs, filter("AND", [cond("employer", "contains", "CORP")]))).toEqual(["acme"]);
  });

  it("not_contains: excludes matches, and an EMPTY field passes", () => {
    expect(ids(jobs, filter("AND", [cond("employer", "not_contains", "acme")]))).toEqual([
      "beta",
      "blank",
    ]);
  });

  it("is_empty: only the blank field", () => {
    expect(ids(jobs, filter("AND", [cond("employer", "is_empty")]))).toEqual(["blank"]);
  });

  it("is_not_empty: everything with a value", () => {
    expect(ids(jobs, filter("AND", [cond("employer", "is_not_empty")]))).toEqual(["acme", "beta"]);
  });

  it("treats a whitespace-only field as empty", () => {
    const ws = [job({ id: "ws", status: "lead", role: "   " })];
    expect(ids(ws, filter("AND", [cond("role", "is_empty")]))).toEqual(["ws"]);
  });
});

describe("date operators", () => {
  const jobs = [
    job({ id: "early", status: "lead", deadline: "2026-06-01" }),
    job({ id: "mid", status: "lead", deadline: "2026-07-01" }),
    job({ id: "late", status: "lead", deadline: "2026-08-01" }),
    job({ id: "none", status: "lead", deadline: null }),
  ];

  it("before: strictly earlier, absent dates never match", () => {
    expect(ids(jobs, filter("AND", [cond("deadline", "before", "2026-07-01")]))).toEqual(["early"]);
  });

  it("after: strictly later, absent dates never match", () => {
    expect(ids(jobs, filter("AND", [cond("deadline", "after", "2026-07-01")]))).toEqual(["late"]);
  });

  it("on: exact calendar day", () => {
    expect(ids(jobs, filter("AND", [cond("deadline", "on", "2026-07-01")]))).toEqual(["mid"]);
  });

  it("is_empty / is_not_empty on a date field", () => {
    expect(ids(jobs, filter("AND", [cond("deadline", "is_empty")]))).toEqual(["none"]);
    expect(ids(jobs, filter("AND", [cond("deadline", "is_not_empty")]))).toEqual(["early", "mid", "late"]);
  });

  it("completed is DERIVED (applied date only for submitted+ jobs)", () => {
    const derived = [
      // submitted with an applied date -> completed = 2026-07-02
      job({ id: "done", status: "submitted", applied: "2026-07-02" }),
      // pre-application: applied set but status is drafted -> no completion
      job({ id: "draft", status: "drafted", applied: "2026-07-02" }),
      // submitted but no applied date -> no completion
      job({ id: "noapp", status: "submitted", applied: null }),
    ];
    expect(ids(derived, filter("AND", [cond("completed", "is_not_empty")]))).toEqual(["done"]);
    expect(ids(derived, filter("AND", [cond("completed", "on", "2026-07-02")]))).toEqual(["done"]);
  });
});

describe("combinators AND vs OR", () => {
  const jobs = [
    job({ id: "a", status: "offer", fit: "strong" }),
    job({ id: "b", status: "offer", fit: "stretch" }),
    job({ id: "c", status: "lead", fit: "strong" }),
    job({ id: "d", status: "lead", fit: "stretch" }),
  ];

  it("AND requires every condition", () => {
    const f = filter("AND", [cond("status", "is", "offer"), cond("fit", "is", "strong")]);
    expect(ids(jobs, f)).toEqual(["a"]);
  });

  it("OR requires at least one condition", () => {
    const f = filter("OR", [cond("status", "is", "offer"), cond("fit", "is", "strong")]);
    expect(ids(jobs, f)).toEqual(["a", "b", "c"]);
  });

  it("AND across three conditions narrows further", () => {
    const three = filter("AND", [
      cond("status", "is", "offer"),
      cond("fit", "is", "strong"),
      cond("employer", "is_not_empty"),
    ]);
    expect(ids(jobs, three)).toEqual(["a"]);
  });
});

describe("undefined / missing field handling", () => {
  it("enum 'is' never matches a blank field", () => {
    const jobs = [job({ id: "blank", status: "lead", sector: "" })];
    expect(ids(jobs, filter("AND", [cond("sector", "is", "public")]))).toEqual([]);
  });

  it("date before/after/on never match a null date", () => {
    const jobs = [job({ id: "n", status: "lead", applied: null })];
    expect(ids(jobs, filter("AND", [cond("applied", "before", "2030-01-01")]))).toEqual([]);
    expect(ids(jobs, filter("AND", [cond("applied", "after", "2000-01-01")]))).toEqual([]);
    expect(ids(jobs, filter("AND", [cond("applied", "on", "2026-01-01")]))).toEqual([]);
  });

  it("matchCondition is a pure boolean per job", () => {
    const j = job({ id: "x", status: "offer" });
    expect(matchCondition(j, cond("status", "is", "offer"))).toBe(true);
    expect(matchCondition(j, cond("status", "is", "lead"))).toBe(false);
  });
});

describe("isConditionComplete", () => {
  it("empty-presence operators are always complete", () => {
    expect(isConditionComplete(cond("employer", "is_empty"))).toBe(true);
    expect(isConditionComplete(cond("deadline", "is_not_empty"))).toBe(true);
  });
  it("single-value operators need a non-blank value", () => {
    expect(isConditionComplete(cond("status", "is", ""))).toBe(false);
    expect(isConditionComplete(cond("status", "is", "   "))).toBe(false);
    expect(isConditionComplete(cond("status", "is", "offer"))).toBe(true);
  });
  it("is_any_of needs at least one option", () => {
    expect(isConditionComplete(cond("status", "is_any_of", []))).toBe(false);
    expect(isConditionComplete(cond("status", "is_any_of", ["offer"]))).toBe(true);
  });
});

describe("distinctValues", () => {
  it("returns sorted distinct non-blank values", () => {
    const jobs = [
      job({ id: "1", status: "lead", sector: "public" }),
      job({ id: "2", status: "lead", sector: "private" }),
      job({ id: "3", status: "lead", sector: "public" }),
      job({ id: "4", status: "lead", sector: "" }),
    ];
    expect(distinctValues(jobs, "sector")).toEqual(["private", "public"]);
  });
});

describe("condition mutation helpers keep a valid condition", () => {
  it("changeField resets the operator when it is illegal for the new type", () => {
    const c = cond("employer", "contains", "acme"); // text operator
    const next = changeField(c, "deadline"); // date field
    expect(next.field).toBe("deadline");
    expect(next.operator).toBe("before"); // first date operator
    expect(next.value).toBe("");
  });

  it("changeField keeps a shared operator (is_empty) across types", () => {
    const c = cond("employer", "is_empty");
    const next = changeField(c, "deadline");
    expect(next.operator).toBe("is_empty");
  });

  it("changeOperator to is_any_of lifts a single value into an array", () => {
    const c = cond("status", "is", "offer");
    const next = changeOperator(c, "is_any_of");
    expect(next.value).toEqual(["offer"]);
  });

  it("changeOperator to a no-value operator clears the value", () => {
    const c = cond("employer", "contains", "acme");
    const next = changeOperator(c, "is_empty");
    expect(next.value).toBe("");
  });

  it("newCondition defaults to a valid, inert status condition", () => {
    const c = newCondition();
    expect(c.field).toBe("status");
    expect(c.operator).toBe("is");
    expect(isConditionComplete(c)).toBe(false);
  });
});

describe("persistence round-trip + tolerant parse", () => {
  it("serialize -> parse preserves a real filter", () => {
    const f = filter("OR", [
      cond("status", "is_any_of", ["offer", "interview"]),
      cond("employer", "contains", "acme"),
    ]);
    const back = parseFilter(serializeFilter(f));
    expect(back.combinator).toBe("OR");
    expect(back.conditions).toHaveLength(2);
    expect(back.conditions[0].value).toEqual(["offer", "interview"]);
    expect(back.conditions[1].operator).toBe("contains");
  });

  it("parse of null / garbage yields the empty filter", () => {
    expect(parseFilter(null).conditions).toEqual([]);
    expect(parseFilter("not json{").conditions).toEqual([]);
    expect(parseFilter("42").conditions).toEqual([]);
  });

  it("parse DROPS an unknown field or an operator illegal for the field", () => {
    const raw = JSON.stringify({
      combinator: "AND",
      conditions: [
        { id: "x", field: "not_a_field", operator: "is", value: "y" },
        { id: "y", field: "employer", operator: "before", value: "z" }, // date op on text field
        { id: "z", field: "status", operator: "is", value: "offer" }, // valid
      ],
    });
    const parsed = parseFilter(raw);
    expect(parsed.conditions.map((c) => c.id)).toEqual(["z"]);
  });

  it("defaults an unknown combinator to AND", () => {
    const raw = JSON.stringify({ combinator: "XOR", conditions: [] });
    expect(parseFilter(raw).combinator).toBe("AND");
  });
});
