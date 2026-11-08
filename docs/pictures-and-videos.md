# Pictures and video clips

Nekko Agent makes pictures, edits photos and makes short video clips with models that run on your own computer. You don't need to know which files a picture model needs or how to set it up: Nekko picks models that fit your computer, downloads everything they need in one go, and sets them up.

## Your first picture

1. Open **Photo** from the **+** menu, or an empty zone on the board.
2. If this computer has no picture model yet, the chat offers up to three, picked for it. Each says what it is good at, how big the download is and how it fits ("Fits your RTX 4060", "with little room to spare", "keeping part of it in system memory, so pictures take longer"). A model too large for this computer is shown but can't be chosen.
3. Press **Download and set up**. Nekko installs the free picture engine if it's missing, downloads the model, then its supporting files (the text encoder and the decoder it can't run without). The download is the same one shown in **Models → Downloads**, so you can leave the chat and come back, or cancel it there.
4. When it's ready, describe the picture and send.

Pick a **Shape** (Square, Landscape, Portrait, Wide or Tall) under the message box. **Advanced** has Steps, Prompt guidance (CFG) and Seed with a short explanation of each, and **Restore model defaults**. You don't need to change them to begin.

## Editing a photo

Attach a photo to change it: press the photo button beside the message box, paste one, or drop it on the chat. Or press **Edit** under a picture the chat made. Then describe the change and send.

- PNG, JPEG and WebP photos, up to four at once. Big photos are scaled down before they are sent, so the model doesn't run out of memory.
- The result keeps the photo's shape. The photo you sent stays in the chat; the result is a new picture, not an overwrite.
- If the chat's model can't edit photos, Nekko doesn't send it the photo. It offers one that can: a model already on this computer, or the **Edit photos** picks for it. Your prompt and photo stay in the message box, so you only press send again.
- Models change details they weren't asked to. Check the result before relying on a precise edit. Masks (editing only part of a photo) aren't offered yet.

## Short video clips (experimental)

**Wan 2.2 TI2V 5B** makes clips of about two seconds (33 frames at 16 frames a second, about 832×480) in your chat's shape, or the photo's.

- In **Models**, **Best for this machine** lists it under **Create video clips** when this computer can run it. It needs a graphics card or Apple Silicon with enough memory; on the processor alone a clip would take hours, so it isn't suggested there.
- Choose it as the model in a Photo chat and describe the clip. Attach a photo to use it as the first frame.
- The clip plays in the chat as an animated picture, with its length beside it. The progress line shows the steps; **Stop** cancels the clip on the engine.
- Clips take minutes and there's no length control yet. Other video models (Wan 2.1, Wan 2.2 A14B, LTX, HunyuanVideo) appear under **Models → Video** but aren't supported yet.

## In Models

- **Best for this machine** lists **Create pictures**, **Edit photos** and **Create video clips** with the pick for this computer, its download (supporting files included), how much memory it needs (an estimate) and its license.
- Filter the list by **All**, **Chat**, **Pictures** or **Video**.
- Open a downloaded picture model to see its checklist (model, supporting files, picture engine). **Finish photo setup** fetches what's missing. A model with no known set of supporting files stays an advanced, unverified setup.
- When a model only fits by keeping part of it in system memory, Nekko turns that on for it the first time a Photo chat uses it.

## Privacy

Pictures and clips are made on your computer. Your prompts and photos aren't sent anywhere. Setting up downloads the model files from Hugging Face and the picture engine from GitHub; neither receives your prompts or photos. Memory and fit are estimates, not measured speed or quality.

## Models offered

| Model | What for | License |
|---|---|---|
| Qwen Image | Best quality, good at lettering inside pictures | Apache-2.0 |
| Z-Image Turbo | Fast, natural-looking pictures; fits smaller computers | Apache-2.0 |
| FLUX.2 klein 4B | Small and quick; makes and edits pictures | Apache-2.0 |
| Qwen Image Edit 2511 | Precise edits that follow instructions | Apache-2.0 |
| Wan 2.2 TI2V 5B | Short video clips (experimental) | Apache-2.0 |

Other picture models you download yourself can work too when they belong to a family Nekko knows (Stable Diffusion 3.5, FLUX.1, FLUX.2, Z-Image, Qwen Image); Nekko then fetches their supporting files the same way.
