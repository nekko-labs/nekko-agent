---
title: "HTML previews run with their folder (Library and the file pane)"
area: desktop
---

# HTML previews run with their folder

## Intent

Requested 2026-11-11: "when opening a design in the library, it doesn't load since it's html. We need to support a webserver for these." A design an agent writes is a page plus its own stylesheet, scripts, images and fonts. The preview drew only the page's text, with scripts off and nothing else allowed to load, so most designs opened as unstyled text. A preview should show the design as it would look in a browser, without giving the page the app, the user's sign-ins or the network. Decision: [0085](../../docs/decisions/0085-html-previews-are-served-with-their-folder.md).

## Behavior

- Previewing a `.html`/`.htm` file in Library or the file pane serves it from a local web server together with its folder, and frames that address live. Scripts (including module scripts), linked stylesheets, images, fonts, media and fetches of files in the folder work. A saved edit reloads the frame.
- **Load from internet**, a toggle above the preview, is off for every newly opened file. Off: the page loads only from its own folder (plus `data:`/`blob:`). On: it may also load from `https:` and connect to `https:`/`wss:`; never `http:`, so no other service on the computer is reachable either way. Switching it re-serves the page at a new address and releases the old one.
- What is served: only files under the page's real folder (symlinks resolved; a link that leaves the folder is refused), never a hidden file or folder (`.env`, `.git/…`), never a secret-looking file (keys, `credentials`, `.npmrc`; the phone rule `phoneFilesSecret`), and only web types (HTML, CSS, JS/MJS/JSX/TSX, JSON/source maps, text/Markdown/CSV, images, fonts, MP4/WebM/MP3/WAV/OGG, WASM, glTF). Single files over 50 MB are refused. A directory serves its `index.html`.
- A page saved directly in a disk root or the home folder is not served ("move it into a folder of its own") and falls back to the scriptless preview with that note.
- Each served page has its own unguessable path; up to 32 are kept, oldest forgotten first, and a preview releases its page when it closes or switches file.
- The frame is `sandbox="allow-scripts allow-forms allow-modals"`: an opaque origin, no popups, no top navigation, no app bridge, no access to the app's cookies or storage. Forms can't submit anywhere (`form-action 'none'`). The page gets in-memory `localStorage`/`sessionStorage` that forget on reload, since real storage is unavailable to an opaque origin.
- Fallback: where the host can't serve the page, or the file is an `.svg`, the existing scriptless preview (with **Open interactive preview** on desktop) shows, with the reason when the server refused.

### Where it runs

- **Desktop:** the main process serves on 127.0.0.1, on a free port chosen at first use, and stops on quit. Only the app's own windows' main frames may ask.
- **Local Web UI:** its server answers the same two calls itself (never forwarded to the engine), behind the same token and origin checks as every API call, and serves on the UI's bind address on a second port (`NEKKO_PREVIEW_PORT` fixes it; otherwise a free one). The URL uses the host name the browser used to open the UI. Not offered when the UI runs through the relay or the page is loaded over `https` (the frame would be unreachable or blocked as mixed content); those keep the scriptless preview.
- The chat's HTML rendering cards are unchanged: still a scriptless picture.

## Privacy and boundaries

The page reads nothing outside its folder and reaches no network until the user allows it for that preview. Its origin is opaque, so even on the Local Web UI's host it can't read the UI's cookies or session token. A Content-Security-Policy does not govern WebRTC, so a script could still open a peer connection while offline; what it could send is limited to its own folder. On a Local Web UI bound beyond loopback, the preview port is reachable on that network too, protected by the unguessable path.

## The design canvas's control script (2026-11-13)

`[implemented, not yet released]` A page served for Library's design canvas (`serveHtmlPreview(path, { controls: true })`) gets one more inline script after the storage stand-in. It answers the frame directly above it, and nothing else, over `postMessage`: asked `probe`, `pause` or `play`, it replies with seven values (running or paused animations, media elements, `requestAnimationFrame` calls so far, whether it is paused, and the page's scroll width and height). Pausing pauses the document's animations and playing media and holds `requestAnimationFrame` callbacks; playing releases them. It reads no cookie, storage, location or content. A page served without `controls` (the file pane, chat cards) is unchanged. Details and the trust reasoning: [Library](library-and-first-visit-guide.md#designs-open-on-a-canvas-with-their-versions), [decision 0091](../../docs/decisions/0091-the-design-canvas-controls-a-served-design-over-postmessage.md).

## Status and verification

Implemented 2026-11-11, not yet released.

- Server: `packages/profile/src/html-preview.test.ts` (real HTTP: folder files, policy with and without internet, hidden/secret/type/escape refusals including raw `..` paths and symlinks, release and the cap, home-folder refusal, doctype-safe storage stand-in).
- Desktop main: `apps/desktop/src/main/htmlPreview.test.ts` (main-frame only, loopback URL, internet only for literal `true`, release, refusals in words).
- Local Web UI: `apps/local-web-ui/src/html-preview.test.ts` (browser host name, IPv6 brackets, own port, release).
- Renderer: `ArtifactPreview.test.tsx` (served frame and toggle when the host can serve, scriptless otherwise; sandbox never has same-origin, popups or top navigation).
- Full-App hidden, isolated Electron journey `apps/desktop/scripts/library-html-preview-sandbox.cjs` (19 checks): a design opened from Library loads its linked stylesheet, external and module scripts, folder image and storage; a remote image is blocked and no request leaves the machine; the origin is opaque and the app document unreachable; `.env` and another local port are refused; **Load from internet** re-serves, releases the old page and lets the `https` image request out; narrow window. The baseline run on the previous code reproduced the bug (stylesheet and image refused, scripts blocked).
- Not verified: the packaged desktop app on macOS/Linux, a real Local Web UI session in a browser, light theme.
