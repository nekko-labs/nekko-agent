# Credits

Nekko Agent stands on a lot of other people's work. This page names the parts a package manager can't see for us (icons, fonts, downloaded runtimes, models, vendored code), and the larger projects that shape the app.

The full list of every package and crate, with each license text, ships inside the app: in the desktop app, open **Settings**, then **Open-source licenses** under Updates. The Android app lists its own under **Settings**, then **About**. Models you choose to download carry their own licenses, shown before you download them.

Thank you to everyone who built and maintains these.

| Name | Used for | Version | License | License file | Source |
| --- | --- | --- | --- | --- | --- |
| Electron and Chromium | The desktop app's window and browser engine | see package-lock.json | MIT | - | [electronjs.org](https://www.electronjs.org) |
| React | The app's interface | see package-lock.json | MIT | - | [react.dev](https://react.dev) |
| Mermaid | Diagrams in chat, and bundled in the iPhone app | 12.2.0 | MIT | vendor/mermaid/LICENSE | [mermaid-js/mermaid](https://github.com/mermaid-js/mermaid) |
| agent-browser | The agent's native browser control, built with a small patch | 0.39.1 | Apache-2.0 | vendor/agent-browser/LICENSE | [vercel-labs/agent-browser](https://github.com/vercel-labs/agent-browser) |
| Remotion | The animated intros for Voice and Dynamic zones, and the website hero intro (video/hero-intro). Not open source: it has its own license, so check that before reusing this code. | see package-lock.json | Remotion License | - | [remotion.dev](https://www.remotion.dev) |
| Inter Tight | Interface font | see package-lock.json | OFL-1.1 | - | [Fontsource](https://fontsource.org/fonts/inter-tight) |
| JetBrains Mono | Code font | see package-lock.json | OFL-1.1 | - | [Fontsource](https://fontsource.org/fonts/jetbrains-mono) |
| Inter Tight, website copy | nekkoagent.com's text font, self-hosted (latin subset) | Fontsource 5.3.0 | OFL-1.1 | apps/website/fonts/OFL-inter-tight.txt | [Fontsource](https://fontsource.org/fonts/inter-tight) |
| JetBrains Mono, website copy | nekkoagent.com's code font, self-hosted (latin subset) | Fontsource 5.3.0 | OFL-1.1 | apps/website/fonts/OFL-jetbrains-mono.txt | [Fontsource](https://fontsource.org/fonts/jetbrains-mono) |
| Handjet | nekkoagent.com's LED-style headings, self-hosted (latin subset) | Fontsource 5.3.1 | OFL-1.1 | apps/website/fonts/OFL-handjet.txt | [Fontsource](https://fontsource.org/fonts/handjet) |
| Space Mono | nekkoagent.com's retro labels, self-hosted (latin subset) | Fontsource 5.3.0 | OFL-1.1 | apps/website/fonts/OFL-space-mono.txt | [Fontsource](https://fontsource.org/fonts/space-mono) |
| Lobe Icons | Provider marks in Settings. The names and marks belong to their owners. | snapshot from @lobehub/icons-static-svg | MIT | apps/desktop/src/renderer/public/providers/LICENSE | [lobehub/lobe-icons](https://github.com/lobehub/lobe-icons) |
| Gentleface | Shared desktop and Local Web UI control icons, including Send, Stop, native SVG motion and the recolored workflow-clock (Scheduled Tasks) rail icon, the pull request and GitHub issue status glyphs, and the plan sheet's Agents label | 0.3.0 | MIT | apps/desktop/src/renderer/assets/gentleface/LICENSE | [gentleface.com](https://gentleface.com/animated-icons) |
| Gentleface navigation glyphs | Library four-square grid and Models brain-circuit, solid-round 16px geometry recolored for the shared desktop/Local Web UI rail | 0.6.0 | MIT | apps/desktop/src/renderer/assets/gentleface/LICENSE | [grid](https://gentleface.com/icons/grid.json), [brain-circuit](https://gentleface.com/icons/brain-circuit.json) |
| Gentleface monitor glyphs | Agents Monitors dock: Utilization bar-chart-horizontal and Automations bolt, line-round/solid-round 16px geometry | 0.6.0 | MIT | apps/desktop/src/renderer/assets/gentleface/LICENSE | [bar-chart-horizontal](https://gentleface.com/icons/bar-chart-horizontal.json), [bolt](https://gentleface.com/icons/bolt.json) |
| Simple Icons | Connector marks. The names and marks belong to their owners. | snapshot | CC0-1.0 | - | [simpleicons.org](https://simpleicons.org) |
| llama.cpp | Runs local models. Downloaded when you set up the model server. | b11985 | MIT | - | [ggml-org/llama.cpp](https://github.com/ggml-org/llama.cpp) |
| stable-diffusion.cpp | Local image generation. Downloaded only if you add it. | master-1030-0a06712 | MIT | - | [leejet/stable-diffusion.cpp](https://github.com/leejet/stable-diffusion.cpp/tree/master-1030-0a06712) |
| whisper.cpp and Whisper Tiny.en | Nekko Voice. Downloaded on first use, with its own notice beside it. | v1.9.2 | MIT | - | [ggml-org/whisper.cpp](https://github.com/ggml-org/whisper.cpp) |
| Ubuntu 24.04 cloud image | The Linux CI runner VM. Downloaded from Canonical onto your Mac when you set up Linux slots; not bundled. | 24.04 (noble, current release) | Ubuntu licensing (GPL-2.0 and other free licenses) | - | [cloud-images.ubuntu.com](https://cloud-images.ubuntu.com/noble/current/) |
| Docker Engine | Containers inside Linux CI runner VMs, installed from Ubuntu's archive at setup; not bundled. | Ubuntu's docker.io | Apache-2.0 | - | [moby/moby](https://github.com/moby/moby) |
| uv | Sets up the MLX runtime on Apple silicon. Downloaded when needed. | 0.12.21 | MIT OR Apache-2.0 | - | [astral-sh/uv](https://github.com/astral-sh/uv) |
| Laya decision models | Quick on-device decisions, converted to ONNX by Nekko Labs | decision-models-v1 | Apache-2.0 | scripts/decision-models/LICENSE | [convaiinnovations](https://huggingface.co/convaiinnovations) |

## GitHub contributor profile avatars

The marketing homepage uses public GitHub profile avatars solely to credit the repository's contributors, with a link to each profile. Philip approved this use for the contributor section. These are user-owned profile images, not MIT-licensed project assets; no blanket reuse license is claimed. They are fetched at website build time, served first-party, regenerated on each deploy, and never committed. An unavailable image falls back to initials. Source: the [GitHub contributors API](https://docs.github.com/en/rest/repos/repos#list-repository-contributors) and each linked profile. Applicable [GitHub terms, sections D and H](https://docs.github.com/en/site-policy/github-terms/github-terms-of-service). Removal or correction requests: hello@nekkoagent.com.

## Approval-choice icons (#2095)

Gentleface 0.3.0 `hand`, `shield-check`, and `running` (line-round/solid-round, 16px), by andaja, MIT. Source: <https://gentleface.com/icons.json> and `https://gentleface.com/svg/{line-round,solid-round}/16/{hand,shield-check,running}.svg`. Vendored in `apps/desktop/src/renderer/gentleface-icons.tsx`; the line paths are identical in `apps/ios/App/Assets.xcassets/PermissionIcons/` and Android `res/drawable/permission_*.xml`. Native adaptation changes only the container and template tint, not the artwork. Copyright/permission notices ship in the desktop Gentleface LICENSE, iOS `PermissionIcons-LICENSE.txt`, and Android `res/raw/license_gentleface_mit.txt` (listed in Licenses). No network fetch at runtime.
