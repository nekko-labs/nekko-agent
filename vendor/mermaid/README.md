# Bundled Mermaid (iPhone app)

`mermaid.min.js` is the `mermaid` npm package's `dist/mermaid.min.js`, at the version `package-lock.json` resolves for the desktop (`apps/desktop/package.json`), so the phone draws diagrams with the same Mermaid the desktop uses. `pin.json` records the version, the npm tarball's integrity (checked against the lockfile before anything is written) and the file's sha256. `LICENSE` is Mermaid's (MIT); the bundle also carries the license comments of the libraries it includes (DOMPurify, d3 and others).

Update with `node scripts/vendor-mermaid.mjs` after the desktop's Mermaid changes; `node scripts/vendor-mermaid.mjs --check` (run by the Native iOS workflow) fails when this copy and the lockfile disagree.

The app ships this folder as a resource (`apps/ios/project.yml`) and runs the script only in its locked, off-screen renderer (`apps/ios/App/Views/Mermaid.swift`): no network, no navigation, `securityLevel: 'strict'`. See [Mermaid diagrams on the phone](../../spec/phone/mermaid-diagrams-on-the-phone.md).
