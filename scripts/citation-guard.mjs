#!/usr/bin/env node
/** Citation guard — every path/to/file.ext citation in a doc or a code
 *  comment must point at a file that actually exists in the tree.
 *
 *  Scans the full text of tracked .md/.mdx files, and the COMMENT text only
 *  of tracked .ts/.tsx/.mjs source, including tests — comment-only scanning is
 *  what makes tests safe to include: a fixture literal like
 *  `source: "docs/<name>.md"` is mock knowledge-base data outside any
 *  comment, so it is never a candidate in the first place.
 *
 *  A citation is resolved against the repo root AND against every ancestor
 *  directory of the file that cites it, because many packages (cloud/console,
 *  packages/apps, fixtures/mcp-e2e, ...) nest their OWN scripts/, docs/ and
 *  fixtures/ directories, and a comment inside one of them written as
 *  `scripts/<name>.ts` means package-relative, not repo-root-relative.
 *
 *  A citation covered by .gitignore (a path the prose documents as a RUNTIME
 *  OUTPUT, e.g. "the run writes corpus/.repos/.logs/ai-scoreboard.md") is not
 *  checked against the committed tree — that's what makes it gitignored.
 *
 *  CREDITS.md and CHANGELOG.md files cite paths in THIRD-PARTY upstream repos
 *  (attribution) or are changesets-generated history; corpus/expectations/**
 *  grades pinned THIRD-PARTY host repos cloned at eval time. None of those
 *  paths live in this tree, by design, so those files are not scanned.
 *
 *  Because this scans `git ls-files`, it cannot see itself until it is
 *  committed — a local run against the untracked working copy silently skips
 *  this very file, examples and all.
 *
 *  Run: node scripts/citation-guard.mjs  (wired into `pnpm lint`).
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

const EXCLUDE_FILES = new Set(["CREDITS.md"]);
const isExcluded = (f) => EXCLUDE_FILES.has(f) || f.endsWith("CHANGELOG.md") || f.startsWith("corpus/expectations/");

const PREFIXES = [
  "packages", "examples", "fixtures", "corpus", "genbench",
  "scripts", "docs-site", "docs", "cloud", "oss", "assets",
];
const EXT = "tsx|mjs|cjs|json|mdx|ts|js|sql|md|yml|yaml";
// A maximal run of path characters ending in a known extension. Requiring the
// captured token itself to START with a known top-level dir (below) — rather
// than searching for the prefix anywhere inside a longer run — is what keeps
// this from matching a truncated tail of a longer path (e.g. picking
// "fixtures/<name>.json" out of the middle of "cloud/console/fixtures/<name>.json") or
// the tail of a github blob URL ("main/packages/foo.ts"). The extension
// alternation is ordered longest-first (tsx before ts, json before js, mdx
// before md) because JS regex alternation takes the first alternative that
// matches, not the longest.
const TOKEN_RE = new RegExp(`[A-Za-z0-9_./-]+\\.(?:${EXT})`, "g");

// Block comments as whole chunks, and each maximal run of contiguous `//`
// lines as one chunk — locality that matters below, because a "Ported from"
// disclaimer and the upstream path it excuses are rarely on the same line.
function commentChunks(source) {
  const chunks = [...source.matchAll(/\/\*[\s\S]*?\*\//g)].map((m) => m[0]);
  let run = null;
  for (const line of source.split("\n")) {
    const i = line.indexOf("//");
    if (i === -1) {
      if (run !== null) chunks.push(run);
      run = null;
    } else {
      run = run === null ? line.slice(i) : `${run}\n${line.slice(i)}`;
    }
  }
  if (run !== null) chunks.push(run);
  return chunks;
}

function gitFiles(...patterns) {
  return execFileSync("git", ["ls-files", "-z", ...patterns], { cwd: root, maxBuffer: 1024 * 1024 * 32 })
    .toString("utf8")
    .split("\0")
    .filter(Boolean);
}

// "Ported from pi-mono `packages/agent/...ts` (MIT, ...)" — CREDITS.md's own
// words are "every port carries an attribution comment at the site of use
// naming the source file and license"; that source file lives in the
// UPSTREAM repo, not this one, exactly like CREDITS.md itself (excluded
// above). The marker is the same word CREDITS.md uses for the roll-up.
const isAttribution = (chunk) => /\b(ported from|adapted from|MIT|Apache-2\.0|BSD-|ISC)\b/i.test(chunk);

function citationsIn(chunks) {
  const found = new Set();
  for (const chunk of chunks) {
    if (isAttribution(chunk)) continue;
    for (const tok of chunk.match(TOKEN_RE) ?? []) {
      const p = tok.replace(/^\.\//, "");
      if (PREFIXES.some((pre) => p === pre || p.startsWith(`${pre}/`))) found.add(p);
    }
  }
  return found;
}

// citedPath -> citingFile -> true
const citations = new Map();
const record = (path, file) => {
  if (!citations.has(path)) citations.set(path, new Set());
  citations.get(path).add(file);
};

for (const f of gitFiles("*.md", "*.mdx")) {
  if (isExcluded(f)) continue;
  const text = readFileSync(join(root, f), "utf8");
  // Paragraphs, not the whole file, so one license mention anywhere in a long
  // doc (e.g. crediting an on-prem vendor's own license) can't blanket-excuse
  // every citation in the rest of the file.
  for (const p of citationsIn(text.split(/\n{2,}/))) record(p, f);
}

for (const f of gitFiles("*.ts", "*.tsx", "*.mjs")) {
  if (isExcluded(f)) continue;
  const text = readFileSync(join(root, f), "utf8");
  for (const p of citationsIn(commentChunks(text))) record(p, f);
}

const isIgnored = (p) => {
  try {
    execFileSync("git", ["check-ignore", "-q", p], { cwd: root });
    return true;
  } catch {
    return false;
  }
};

/** True if `p` resolves at the repo root or relative to any ancestor
 *  directory of any file that cites it. */
function resolves(p, citingFiles) {
  if (existsSync(join(root, p))) return true;
  for (const file of citingFiles) {
    let dir = dirname(join(root, file));
    while (dir !== root && dir !== dirname(dir)) {
      if (existsSync(join(dir, p))) return true;
      dir = dirname(dir);
    }
  }
  return false;
}

let dead = 0;
let total = 0;
for (const [p, files] of [...citations].sort(([a], [b]) => a.localeCompare(b))) {
  total += 1;
  if (resolves(p, files) || isIgnored(p)) continue;
  dead += 1;
  const list = [...files].sort();
  const shown = list.slice(0, 3).join(", ") + (list.length > 3 ? `, +${list.length - 3} more` : "");
  console.error(`citation-guard: DEAD ${p} (cited by ${shown})`);
}

if (dead > 0) {
  console.error(`citation-guard: ${dead} dead citation(s) out of ${total} checked`);
  process.exit(1);
}
console.log(`citation-guard: ${total} citations checked, all resolve`);
