---
title: "iPhone: All, Cloud and Local tabs on the model picker (2026-11-05)"
area: phone
---

# iPhone: All, Cloud and Local tabs on the model picker (2026-11-05)

**User intent:** Philip asked (2026-11-05) for the phone's model selection to get the desktop picker's top-level groups as a segmented slider, so the list can be narrowed to all cloud or all local models, matching the desktop.

**Status `[implemented 2026-11-05 on the native iPhone app; the filter logic (NekkoKit `ModelScope`) has unit tests passing in the Linux Swift container; the SwiftUI views compile and run only on the macOS CI (Native iOS), where the UI test `ModelTabsTests` switches the tabs over a seeded computer (`-uiTestModelTabs`: one cloud provider, one local) and checks each tab's rows; this iPhone's own picker is not driven by a test; Android not done]`**

**What the desktop does** (`apps/desktop/src/renderer/components/agent-console/ModelPicker.tsx`): a "Model source" group of four segments at the top of the picker, **All**, **Fusion**, **Cloud**, **Local**, opening on All every time. Cloud and Local filter the providers by `isLocalProvider` (`LOCAL_PROVIDER_KINDS`: llama.cpp, Ollama, LM Studio, vLLM), and the starred, recent and default rows follow the filter. Every segment stays on offer when it has nothing to list; the list then says there are no models. Fusion is Auto routing and is disabled where Auto is not offered.

**On the iPhone:**

- Both pickers, the computer's (`ModelPicker`: New chat, a chat's model chip, Model and effort) and this iPhone's (`PhoneModelPicker`, for chats that run on the iPhone), show a segmented control pinned under the title: **All**, **Cloud**, **Local**, in the desktop's order and words. There is no Fusion: the phone never offers Auto.
- It opens on **All** each time, as the desktop does. Switching only filters the list; it never picks a model or changes the chat.
- **Cloud** lists the providers that are not local model servers, **Local** the ones that are (`PublicProvider.isLocal`, the same kinds as the desktop). *Starred on your computer* follows the tab. Search works within the tab.
- An empty tab stays selectable and says so: *No local model servers on this computer.* or *No cloud providers on this computer.* On this iPhone every provider is a cloud API (local servers need a computer), so its Local tab says *Local models run on a computer. Start the chat on a computer to use them.*
- Accessibility: the control is labelled *Model source* (identifier `modelPicker.scope`); the empty-tab line is `modelPicker.emptyScope`. New strings are in `Localizable.xcstrings` in the app's seven languages.

**Computer details (#2053, in progress):** The Models section starts collapsed and shows a count. Expanding it offers **All**, **Cloud** and **Local** filters, using the computer's provider kinds; an empty group says so. This is separate from choosing a model in the picker. The iOS source is implemented, but native build and visual verification for this change are in progress. Android parity is tracked under [parent #2053](https://github.com/nekko-labs/nekko-agent/issues/2053) until a separate issue exists.

**Acceptance:** with a computer that has a cloud provider and a local one, Cloud shows only the cloud provider's section and its stars, Local only the local one's, All both; picking a model in any tab picks it as before.

**Privacy and security:** none new. The filter reads the provider kinds the phone already receives (`providers:list`); nothing is sent or stored.

**Not done:** Android's model list has no tabs yet. Screenshots come from the macOS CI run's UI-test attachments.
