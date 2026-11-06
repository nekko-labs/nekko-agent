---
title: "Your first local model"
area: models
---

# Your first local model

**What it is for.** Someone who has never run a model on their computer should get from "I want AI on this machine" to a reply in one press and one wait, without first learning what an engine, a runtime, a build or a quantization is. The full Model Server page answers every question an experienced user has, and to a newcomer it was a wall: two servers, a build picker, an image runtime, five per-task picks with quant codes and tokens per second, a search, memory panels and connected servers, with nothing saying which comes first. ([#1223](https://github.com/nekko-labs/nekko-agent/issues/1223))

**Who sees it.** `[implemented, unit-tested; renderer-verified in an isolated fixture; not yet run end to end against a real engine and download]` Models > Local model server opens on a guided screen instead of the full page when this machine has no local model (models found in another app's folder count, so an Ollama or LM Studio user never sees it) and no local server of the user's own is connected. The choice is made once per visit, so the screen stays put while its own download lands. Until the engine answers, neither screen is drawn, so the full page never flashes first. Anyone else, and anyone who presses **Show all models and settings**, gets the full page unchanged.

**Three steps, one question.**

1. **Choose.** "Run AI on this computer": two cards, **Everyday help** (writing, questions, summaries and planning) and **Writing code**, each naming the model it gets and its download size. The models are this machine's own recommendations for the chat and coding tasks ([hardware-aware recommendations](hardware-aware-model-recommendations.md)), at the quant those pick. One line under the cards says the fit in words ("Runs well on your NVIDIA GeForce RTX 4060", "Fits ..., with little room to spare", and "Replies may be slow on this computer" when nothing that fits reaches the task's speed). No quant codes, tokens per second, backend names or the word "runtime" appear. One button, **Download and set up**, with the size beside it; when there is no engine yet, the line adds "plus the small free engine that runs it". Nothing downloads before the press.
2. **Download.** The press queues the recommended engine build (only when none is installed) and the model, together. The screen shows them as steps: get the engine, download the model (a progress bar with size and time left), ready to chat. **Cancel** cancels both. A failed download is said in a sentence above the cards with the button offered again; downloads resume.
3. **Start chatting.** "<Model> is ready", with a line that Nekko starts it whenever the app opens (a finished download already turns on start-with-Nekko). **Start chatting** starts the model server if it is stopped, makes the new model the active model and opens a new chat.

**Falls back to the full page** when there is nothing to offer: no recommendations (the feed failed to load), no chat or coding pick, or no engine build this platform can download.

**Not here, on purpose.** Routing, embedding and vision picks, the image runtime, the agent server, folders and decision models are left to the full page: none of them is needed for a first reply.

**Not verified.** The fixture covers every state with a stubbed engine; a real engine install, a real multi-gigabyte download and the hand-off into a chat with the downloaded model have not been run end to end.
