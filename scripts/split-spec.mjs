#!/usr/bin/env node
/**
 * One-time migration: split the single SPEC.md into one file per feature
 * under spec/<area>/, write the spec/README.md index, and rewrite every
 * `SPEC.md#anchor` link in the repo to the file that now holds that heading.
 *
 * Rerunnable on a newer main: it reads SPEC.md as it stands, so a branch that
 * conflicts with the split can take main's SPEC.md, run this again, and commit
 * the result. Once SPEC.md is the short pointer it writes, the script refuses
 * to run (there is nothing left to split).
 *
 *   node scripts/split-spec.mjs            # split and rewrite links
 *   node scripts/split-spec.mjs --dry-run  # print the plan only
 *
 * After the split, `node scripts/spec-index.mjs` keeps spec/README.md current.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { slug as githubSlug, writeIndex, AREAS } from './spec-index.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const SPEC = path.join(ROOT, 'SPEC.md');
const OUT = path.join(ROOT, 'spec');
const dry = process.argv.includes('--dry-run');
const SPLIT_DATE = new Date().toISOString().slice(0, 10);


/** The two top-level sections that are only containers: each `###` under them is a feature. */
const CONTAINERS = new Set(['User Journeys & Experiences', 'Feature Set']);

/** First match wins; tested against the section's heading text. */
const AREA_RULES = [
  [/^(Products and their names|Vision|Why It Exists|Who It's For|What Success Looks Like|Scope Boundaries|Open Questions|Contributing: how changes land|Claude policy|Editions, same engine)/, 'product'],
  [/(Brand refresh|marketing website|Beta signups|Mascot, polish|First-run setup)/, 'brand'],
  [/(phone|Android|iOS app|in your pocket)/i, 'phone'],
  [/^Composer (containment|Markdown)/, 'chat'],
  [/(Mode panel|Work Modes|Context Inspector|Living spec|Context, guardrails|Workspaces, indexing)/, 'context'],
  [/(Server, model browser|Running a model with nothing|Setting up a local model|First-agent provider|Signing in with a subscription|Models & providers|Model training|Training a model|Prompt caching|Anthropic image-dimension)/, 'models'],
  [/(PR stacks|Working in a codebase|In-chat pull requests|Completion PR verification|Editing, reviewing|Design tab|Files, editor|Repository review|Rich responses, reports)/, 'code'],
  [/(Workflows|Tooling & integrations|outbound resource queue|offline PC control|long-running goal)/, 'automation'],
  [/(Speed & responsiveness|How it's built|Distribution & platforms|Build storage|macOS identity|Windows installs|Noninteractive shell|Page recovery|Startup splash)/, 'platform'],
  [/(Agent panel|Agents panel|Subagent|subagent|Delegating|Agents dashboard|Agent activity|Monitors dock|Agent Monitor|Approval retention)/, 'agents'],
  [/(wall|Wall|rail|Rail|Navigation|Nav wings|window|Window|Command Center|Focused mode|Grid model selection|Search within Settings|Model picker)/, 'desktop'],
  [/./, 'chat'],
];

const areaOf = (title) => AREA_RULES.find(([re]) => re.test(title))[1];

/** A file name from a heading: the slug without a trailing date, capped. */
function fileSlug(title) {
  const base = githubSlug(title.replace(/\s*\((?:[^()]*\b20\d\d-\d\d-\d\d\b[^()]*|implemented[^()]*|planned[^()]*)\)\s*$/i, ''));
  return base.replace(/-{2,}/g, '-').slice(0, 64).replace(/-+$/, '') || 'section';
}

function parse(text) {
  // SPEC.md opens with a frontmatter block that later sections were pasted
  // into; the real frontmatter fields are dropped, the sections are kept.
  const lines = text.split('\n').filter((l) => !/^(status|last-updated|owner):/.test(l));
  const sections = [];
  const anchors = []; // every heading in document order, for GitHub's duplicate numbering
  let h2 = null, cur = null, inFence = false;
  const open = (title, level) => {
    cur = { title, level, lines: [] };
    sections.push(cur);
  };
  for (const line of lines) {
    if (/^```/.test(line)) inFence = !inFence;
    const m = !inFence && /^(#{1,6}) (.*)$/.exec(line);
    if (m) {
      const level = m[1].length, title = m[2].trim();
      anchors.push({ title, level });
      if (level === 1) { cur = null; continue; }
      if (level === 2) {
        h2 = title;
        if (CONTAINERS.has(title)) { cur = null; continue; }
        open(title, 2);
        continue;
      }
      if (level === 3 && CONTAINERS.has(h2)) { open(title, 3); continue; }
    }
    if (line.trim() === '---' && !cur) continue;
    if (cur) cur.lines.push(line);
    else if (line.trim() && !/^>/.test(line)) {
      // Text outside any section (the old intro paragraph) goes to the product brief.
      (sections.preamble ??= []).push(line);
    }
  }
  return { sections, anchors };
}

/** GitHub's anchor for each heading in SPEC.md, with -1, -2 for repeats. */
function oldAnchors(anchors) {
  const seen = new Map();
  return anchors.map(({ title }) => {
    const s = githubSlug(title);
    const n = seen.get(s) ?? 0;
    seen.set(s, n + 1);
    return { title, anchor: n ? `${s}-${n}` : s };
  });
}

function main() {
  const text = fs.readFileSync(SPEC, 'utf8');
  if (text.includes('<!-- spec-split -->')) {
    console.error('SPEC.md is already the pointer to spec/; nothing to split.');
    process.exit(1);
  }
  const { sections, anchors } = parse(text);
  const files = new Map(); // rel path -> { title, area, parts: [] }
  const where = new Map(); // heading title -> rel path (first file holding it)
  for (const s of sections) {
    const body = s.lines.join('\n').trim();
    if (!body) continue;
    const area = areaOf(s.title);
    const rel = `spec/${area}/${fileSlug(s.title)}.md`;
    // Demote so the section heading becomes the file's H1.
    const shift = s.level - 1;
    const demoted = body.split('\n').map((l) => {
      const m = /^(#{2,6}) (.*)$/.exec(l);
      return m ? `${'#'.repeat(Math.max(2, m[1].length - shift))} ${m[2]}` : l;
    }).join('\n');
    const f = files.get(rel) ?? { title: s.title, area, parts: [] };
    // A heading SPEC.md repeats (two "Command Center header spacing") lands in one file.
    f.parts.push(f.parts.length ? `## ${s.title}\n\n${demoted}` : demoted);
    files.set(rel, f);
    if (!where.has(s.title)) where.set(s.title, rel);
    for (const l of body.split('\n')) {
      const m = /^#{2,6} (.*)$/.exec(l);
      if (m && !where.has(m[1].trim())) where.set(m[1].trim(), rel);
    }
  }
  if (sections.preamble?.length) {
    const rel = 'spec/product/overview.md';
    const f = files.get(rel) ?? { title: 'Overview', area: 'product', parts: [] };
    f.parts.unshift(sections.preamble.join('\n').trim());
    files.set(rel, f);
  }

  // Old anchor -> new target. A heading's anchor inside its new file is its
  // own slug, numbered again only if that file repeats it.
  const map = new Map();
  for (const { title, anchor } of oldAnchors(anchors)) {
    const rel = where.get(title);
    if (!rel) continue;
    const file = files.get(rel);
    const isTop = file.title === title;
    map.set(anchor, isTop ? rel : `${rel}#${githubSlug(title)}`);
  }

  const counts = {};
  for (const f of files.values()) counts[f.area] = (counts[f.area] ?? 0) + 1;
  console.log(`${files.size} files from ${sections.length} sections:`, counts);
  if (dry) {
    for (const [rel, f] of files) console.log(`  ${rel}  <- ${f.title}`);
    return;
  }

  fs.rmSync(OUT, { recursive: true, force: true });
  for (const [rel, f] of files) {
    const out = path.join(ROOT, rel);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    const front = `---\ntitle: ${JSON.stringify(f.title)}\narea: ${f.area}\nsplit-from: SPEC.md (${SPLIT_DATE})\n---\n\n`;
    fs.writeFileSync(out, `${front}# ${f.title}\n\n${f.parts.join('\n\n').trim()}\n`);
  }
  writeIndex(ROOT);
  fs.writeFileSync(SPEC, `<!-- spec-split -->
# Spec, Nekko Agent

The product spec moved to [spec/](spec/README.md) on ${SPLIT_DATE}: one file per feature, grouped by area, with an index.
Update the feature's own file in the same PR as the change (see [AGENTS.md](AGENTS.md#keep-the-product-specification-current)).
The text before the split is in git history: \`git show ${headSha()}:SPEC.md\`.
`);
  const rewritten = rewriteLinks(map);
  console.log(`rewrote SPEC.md links in ${rewritten} files`);
  for (const f of files.values()) {
    if (!AREAS[f.area]) throw new Error(`area without a description: ${f.area}`);
  }
}

function headSha() {
  try { return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT }).toString().trim(); } catch { return 'HEAD'; }
}

/** Rewrite `SPEC.md#anchor` and `](SPEC.md)` in every tracked text file but the spec itself. */
function rewriteLinks(map) {
  const tracked = execFileSync('git', ['ls-files'], { cwd: ROOT }).toString().split('\n').filter(Boolean);
  let changed = 0;
  const unresolved = new Set();
  for (const rel of tracked) {
    if (rel === 'SPEC.md' || rel === 'scripts/split-spec.mjs' || rel.startsWith('spec/') || !/\.(md|mjs|ts|tsx|rs|yml|yaml)$/.test(rel)) continue;
    const full = path.join(ROOT, rel);
    let text;
    try { text = fs.readFileSync(full, 'utf8'); } catch { continue; }
    if (!text.includes('SPEC.md')) continue;
    const dir = path.posix.dirname(rel);
    const relTo = (target) => {
      const r = path.posix.relative(dir, target.split('#')[0]) + (target.includes('#') ? `#${target.split('#')[1]}` : '');
      return r || target;
    };
    const next = text
      // ](../SPEC.md#x) and ](SPEC.md#x), any relative prefix
      .replace(/\]\(((?:\.\.\/|\.\/)*)SPEC\.md#([^)\s]+)\)/g, (all, _pre, anchor) => {
        // An anchor SPEC.md no longer had (a renamed heading) goes to the index.
        const t = map.get(anchor) ?? (unresolved.add(anchor), 'spec/README.md');
        return `](${relTo(t)})`;
      })
      .replace(/\]\(((?:\.\.\/|\.\/)*)SPEC\.md\)/g, () => `](${relTo('spec/README.md')})`)
      // A bare `SPEC.md#x` in prose or a comment: the repo-root path.
      .replace(/(?<![\w/(])SPEC\.md#([\w-]+)/g, (all, anchor) => map.get(anchor) ?? all);
    if (next !== text) {
      fs.writeFileSync(full, next);
      changed++;
    }
  }
  if (unresolved.size) console.log(`anchors SPEC.md did not have (linked to the index): ${[...unresolved].join(', ')}`);
  return changed;
}

main();
