#!/usr/bin/env node
// raw-color-lint - DS-4 remainder (SIM-42): warn-mode raw color literal counter.
//
// Counts #hex / rgb() / hsl() literals under src/ so the off-token backlog is a
// visible number in every `npm run check`. WARN ONLY - always exits 0 (DS-5 owns
// the burn-down; this is the metric, not the gate). Excluded as survivors:
//   - any line tagged `off-token`, plus the tag's following contiguous non-blank
//     block (tags sit in a comment ABOVE the literal(s) they justify);
//   - CSS custom-property DEFINITION lines (`--x: #hex`) - the token source of
//     truth is the one place raw values legitimately live.
//
// Run standalone: node ops/raw-color-lint.mjs

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const COLOR = /#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/g;
const EXTS = new Set([".ts", ".tsx", ".js", ".jsx", ".css", ".html"]);

function* walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (EXTS.has(path.extname(e.name))) yield p;
  }
}

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const perFile = new Map();
let count = 0;
let offToken = 0; // literal lines excluded by an off-token tag (justified survivors)
let tokenDefs = 0; // literal lines that ARE token definitions (--x: #hex)
for (const file of walk(path.join(appRoot, "src"))) {
  let covered = false; // inside an off-token block (tag line .. next blank line)
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    if (line.trim() === "") { covered = false; continue; }
    if (line.includes("off-token")) covered = true;
    const hits = (line.match(COLOR) || []).length;
    if (!hits) continue;
    if (covered) { offToken += 1; continue; }
    if (/^\s*--[\w-]+\s*:/.test(line)) { tokenDefs += 1; continue; }
    count += hits;
    perFile.set(file, (perFile.get(file) || 0) + hits);
  }
}

console.log("[raw-color-lint] src/ raw color literals (#hex / rgb() / hsl()), warn mode");
console.log(
  `  ${count > 0 ? "WARNING" : "OK"} - ${count} raw literal(s) across ${perFile.size} file(s); ` +
    `excluded: ${offToken} off-token survivor line(s), ${tokenDefs} token-definition line(s)`,
);
for (const [f, n] of [...perFile].sort((a, b) => b[1] - a[1])) {
  console.log(`    ${path.relative(appRoot, f).replace(/\\/g, "/")}: ${n}`);
}
process.exit(0);
