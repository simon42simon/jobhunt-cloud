# Data contract

**This file has moved.** The full data contract — what the app may do, what it must never do, the routine runner's separate posture, and configuration — now lives in **`docs/data-schema.md`, §7 "Data contract guarantees"**, alongside the full entity/field schema (every store the app reads or writes, its writer, and its relations to every other store).

It is kept at this root path only so a contributor scanning the repository root (before finding `docs/`) still finds a pointer here. `docs/data-schema.md` is the canonical, hub-visible source (rendered in the Product hub's document browser, which does not serve root-level files) — this file is never a second copy of its content, and is not updated independently of it.

See: `docs/data-schema.md` (start at §7 for the contract guarantees, §2 for the full entity schema).

This app's `data-schema.md §7` is the jobhunt **instance** of the OS sovereignty policy. The app-agnostic **policy/template** it instantiates is the OS canonical `C:\Usersyou\ssc-brain\company-os\os\data-contract.md` (Company OS v2 kernel, carrying the ADR v2-002 amendment; the former home `SSC/os/governance/data-contract.md` is the superseded preserved original — audit F3 fix, 2026-07-10). For the template-vs-instance layering see `company-os/os/doc-taxonomy.md` §3.1.
