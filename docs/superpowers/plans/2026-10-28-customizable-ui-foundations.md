# Customizable UI foundations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the parts of the customizable UI that do not touch the renderer shell being reshaped: the docs, the `.nekko` package format, signatures, the layout and customization documents, and the mod sandbox's policy and bridge.

**Architecture:** Pure, never-throwing parsers and resolvers in `packages/shared` (in the style of `parseSimpleChoices`), so the desktop, the Local Web UI and later Nekko Cloud share them. The mod sandbox's policy (CSP, path resolution) sits beside `previewPolicy.ts`, and its bridge sits in the renderer under `mods/`. Nothing is mounted in the shell yet.

**Tech Stack:** TypeScript, vitest, Web Crypto (`crypto.subtle`, ECDSA P-256 with SHA-256). No new dependencies.

**Spec:** [docs/superpowers/specs/2026-10-28-customizable-ui-design.md](../specs/2026-10-28-customizable-ui-design.md)

## Global Constraints

- No em dashes anywhere (docs, comments, commits).
- No AI attribution in commits, PRs or docs.
- Package limits: 20 MB total; no symlinks, absolute paths or `..` entries; manifest validated before anything is unpacked.
- Kinds: `customization` (no code files), `mod`, `layout`.
- Manifest file `nekko.json`; signatures file `SIGNATURES`; extension `.nekko`; `format: 1`.
- Ids are reverse-DNS: `^[a-z0-9]+(\.[a-z0-9-]+)+$`, at most 128 characters. `nekko.*` is reserved for official layouts.
- Permissions: `chats:read`, `chats:content`, `chats:write`, `hardware:read`, `usage:read`, `network`, `files:read`, `files:write`, `tools:run`.
- Mod frames never get the engine token, preload, cookies or Node.
- Decision records 0030 and 0031 are taken by open PRs (#1312, #1321, #1319). Use 0032 and 0033.

## Review Focus

1. A hostile manifest (wrong types, huge strings, prototype keys like `__proto__`) must parse to errors, never throw or pollute objects. Test in Task 2.
2. Zip entry paths like `a/../../x`, `/etc/x`, `C:\x`, `a\..\x` must be rejected. Test in Task 2.
3. A signed package with one extra file, one missing file, or one changed byte must fail verification. Test in Task 3.
4. A placement naming a surface or slot that does not exist must be ignored on screen and kept in the document. Test in Task 4.
5. A mod URL that escapes its folder by encoding (`%2e%2e/`) must be refused. Test in Task 5.

---

### Task 1: Spec, decisions and task list

**Files:**
- Create: `spec/desktop/customizable-ui.md` (frontmatter `title: "Customizable UI: customizations, mods and custom layouts"`, `area: desktop`)
- Create: `docs/decisions/0032-three-layers-and-the-nekko-package.md`
- Create: `docs/decisions/0033-mods-may-run-agent-tools-behind-a-permission.md`
- Modify: `docs/decisions/README.md` (index rows), `TASKS.md` (new group "Customizable UI (added 2026-10-28)", tasks CUI-1 to CUI-12), `spec/README.md` via `node scripts/spec-index.mjs`

- [ ] Write the spec file from the design: intent, the three layers, what each holds, boundaries (privacy, sandbox, way back), status `[planned; format and sandbox policy implemented 2026-10-28]`.
- [ ] Decision 0032: three layers; `.nekko` zip format; customizations sync through encrypted sync, amending 0030's "never synced" for people who turn sync on.
- [ ] Decision 0033: mods may run agent tools behind `tools:run`, the engine's tool policy, defaulting to Ask, scoped folders.
- [ ] TASKS group with CUI-1 (docs), CUI-2 (manifest), CUI-3 (signatures), CUI-4 (layout and customization docs), CUI-5 (sandbox policy and bridge), then the waiting work: CUI-6 surface registry, CUI-7 Simple and Expert as layouts, CUI-8 Look and layout settings, CUI-9 customizations migration and sync, CUI-10 mod install and protocol wiring, CUI-11 marketplace, CUI-12 Edit layout mode, custom layouts and the authoring skill.
- [ ] Run `node scripts/spec-index.mjs`. Expected: index updated, exit 0.
- [ ] Commit.

### Task 2: Package manifest

**Files:**
- Create: `packages/shared/src/nekko-package.ts`, `packages/shared/src/nekko-package.test.ts`, `packages/shared/schemas/nekko-package-1.json`
- Modify: `packages/shared/src/index.ts` (export)

**Interfaces:**
- Produces:
  - `type PackageKind = 'customization' | 'mod' | 'layout'`
  - `const MOD_PERMISSIONS: readonly ModPermission[]` (the nine above)
  - `const PACKAGE_MAX_BYTES = 20 * 1024 * 1024`
  - `interface PackageManifest { format: 1; kind; id; name; version; description?; author?: {name; url?}; license?; engines?: {'nekko-agent'?: string}; platforms: Array<'desktop'|'phone'>; permissions: ModPermission[]; network: {hosts: string[]}; contributes: PackageContributions; main: string | null; layout: string | null; customization: unknown | null }`
  - `interface PackageContributions { panels: Contribution[]; monitors: Contribution[]; commands: CommandContribution[]; themes: unknown[]; settings: string | null }`, `Contribution { id; label; slots: string[]; entry: string }`, `CommandContribution { id; label; shortcut: string | null }`
  - `parsePackageManifest(raw: unknown): { ok: true; manifest: PackageManifest } | { ok: false; errors: string[] }`
  - `checkPackageEntries(entries: Array<{ path: string; size: number; symlink?: boolean }>, kind: PackageKind): string[]` (empty means fine)

- [ ] Tests: a full valid mod manifest parses; missing `kind`/`id`/`version` each give one error; unknown permission rejected; `nekko.simple` id rejected (reserved); non-semver version rejected; `network` permission with no hosts rejected and hosts without `network` rejected; `kind: 'customization'` with `contributes.panels` non-empty rejected; `__proto__` key in manifest does not pollute `Object.prototype`; strings over 10 000 chars rejected; a JSON string input is parsed, bad JSON gives an error.
- [ ] Tests for entries: `../x`, `a/../../x`, `/x`, `C:/x`, `a\\..\\x`, symlink, total over 20 MB all rejected; missing `nekko.json` rejected; `customization` kind with a `.js` file rejected; contribution `entry` paths are checked by `parsePackageManifest` to be relative and inside the package.
- [ ] Test: the JSON Schema's `kind` enum and `permissions.items.enum` equal `['customization','mod','layout']` and `MOD_PERMISSIONS`.
- [ ] Implement; run `npx vitest run src/nekko-package.test.ts` in `packages/shared`. Expected: PASS.
- [ ] Commit.

### Task 3: Package signatures

**Files:**
- Create: `packages/shared/src/nekko-package-signature.ts`, `packages/shared/src/nekko-package-signature.test.ts`
- Modify: `packages/shared/src/index.ts`

**Interfaces:**
- Produces:
  - `packageListing(files: Record<string, Uint8Array>): Promise<string>`: `nekko-signatures 1\n` then one `<sha256 hex>  <path>\n` line per file except `SIGNATURES`, sorted by path.
  - `signPackageListing(listing: string, keyId: string, key: CryptoKey): Promise<string>`: returns the full `SIGNATURES` text, the listing then `--\n` then `sig <keyId> <base64 signature>\n`. Used by tests and the offline signing script.
  - `verifyPackage(files: Record<string, Uint8Array>, trusted: Record<string, CryptoKey>): Promise<{ verified: boolean; keyId?: string; reason?: string }>`

- [ ] Tests (key made with `crypto.subtle.generateKey({name:'ECDSA', namedCurve:'P-256'})`): sign then verify gives `verified: true, keyId`; one changed byte, an extra file, a missing file, a listing edited after signing, an unknown key id, and no `SIGNATURES` each give `verified: false` with a reason.
- [ ] Implement; run the test. Expected: PASS.
- [ ] Commit.

### Task 4: Layout and customization documents

**Files:**
- Create: `packages/shared/src/ui-layout.ts`, `packages/shared/src/ui-layout.test.ts`
- Modify: `packages/shared/src/index.ts`

**Interfaces:**
- Produces:
  - `type SlotVisibility = 'show' | 'expert' | 'hide'` (same values as `SimpleVisibility` in PR #1312)
  - `interface LayoutDoc { id; name; slots: Record<string, string[]>; visibility: Record<string, SlotVisibility>; board?: { arrangement?: string; zones?: number }; theme: string | null }`
  - `type Placement = string | { slot: string; layout?: string }`
  - `interface Customizations { format: 1; layout: string; visibility; nav: { order: string[]; hidden: string[] }; theme: { preset: string | null; accent: string | null; accent2: string | null; fontSans: string | null; fontMono: string | null; textScale: number }; board: { arrangement?: string }; placements: Record<string, Placement>; mods: Record<string, { enabled: boolean }>; deviceOnly: string[] }`
  - `parseLayoutDoc(raw: unknown): LayoutDoc | null` and `parseCustomizations(raw: unknown): Customizations` (never throw; bad fields fall back to defaults, unknown fields dropped)
  - `resolveSlots(layout: LayoutDoc, opts: { modDefaults?: Record<string, string>; placements?: Record<string, Placement>; allowed: (surface: string, slot: string) => boolean }): Record<string, string[]>`

- [ ] Tests for `resolveSlots`: official contents pass through; a mod default adds a surface to its slot's end; a placement moves a surface (removed from the old slot, appended to the new one); a placement overrides a mod default; a placement pinned to another layout id is ignored; a placement into a slot `allowed` refuses is ignored; a placement to a missing slot or surface is ignored and the input object is unchanged; a surface never appears twice.
- [ ] Tests for parsing: an empty object gives full defaults; bad `textScale` (string, NaN, 10) falls back to 1 (range 0.75 to 1.5); invalid visibility values dropped; `deviceOnly` keeps only known top-level field names.
- [ ] Implement; run the test. Expected: PASS.
- [ ] Commit.

### Task 5: Mod sandbox policy and bridge

**Files:**
- Create: `apps/desktop/src/modPolicy.ts`, `apps/desktop/src/modPolicy.test.ts`
- Create: `apps/desktop/src/renderer/mods/bridge.ts`, `apps/desktop/src/renderer/mods/bridge.test.ts`

**Interfaces:**
- Consumes: `PackageManifest`, `ModPermission` from Task 2.
- Produces:
  - `MOD_SCHEME = 'nekko-mod'`
  - `modCsp(manifest: Pick<PackageManifest, 'permissions' | 'network'>): string`: `default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src <'none' or the https hosts>; form-action 'none'; base-uri 'none'; frame-src 'none'; object-src 'none'; worker-src 'none'`
  - `resolveModPath(root: string, url: string): string | null`: maps `nekko-mod://<id>/<path>` to a file under `root/<id>/`, or null for a bad id, an encoded or plain escape, or a request for `SIGNATURES`/`nekko.json`.
  - `METHOD_PERMISSIONS: Record<string, ModPermission | null>` (method name to the permission it needs; null means no permission)
  - `createBridgeHost(port: MessagePort, opts: { granted: readonly ModPermission[]; handlers: Partial<Record<string, (params: unknown) => unknown | Promise<unknown>>> }): () => void`: replies `{ id, result }` or `{ id, error: { code: 'denied' | 'unknown' | 'failed', message } }`. Returns a dispose function.

- [ ] Tests for `modCsp`: no network gives `connect-src 'none'`; `network` with `api.example.com` gives `connect-src https://api.example.com`; hosts are never added without the permission; a host containing `;`, a space or `'` is dropped.
- [ ] Tests for `resolveModPath`: a normal file resolves inside the root; `..`, `%2e%2e`, `%2F..`, a backslash, an absolute path and an uppercase or invalid id return null; `nekko.json` and `SIGNATURES` return null.
- [ ] Tests for the bridge over a real `MessageChannel`: a no-permission method answers; `tools.run` without `tools:run` gives `denied` and never calls the handler; an unknown method gives `unknown`; a throwing handler gives `failed` without leaking its stack; malformed messages are ignored.
- [ ] Implement; run `npx vitest run src/modPolicy.test.ts src/renderer/mods/bridge.test.ts` in `apps/desktop`. Expected: PASS.
- [ ] Commit.

### Task 6: Verify and land

- [ ] `npm run build -w packages/shared` and `npm run typecheck -w apps/desktop`. Expected: no errors.
- [ ] Full `packages/shared` test run. Expected: PASS.
- [ ] File the GitHub issue (plain title, the what and why), open the PR linking it with an **Unfinished work / release blockers** section listing CUI-6 to CUI-12, "no visual change", queue with `gh pr merge --auto`, turn on Auto-fix.
