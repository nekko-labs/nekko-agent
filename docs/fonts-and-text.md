# Fonts and text

Nekko Agent uses the same two fonts as nekkoagent.com: **Inter Tight** for the interface and **JetBrains Mono** for code. Both ship inside the app, so nothing is downloaded to show them.

Change them in **Settings > Style**:

- **Text size** scales all text and controls, from 80% to 150%.
- **Interface font** is the font for menus, chats and everything that is not code.
- **Code font** is the font for code blocks, paths and other fixed-width text.

Each list offers the default, **System** (your operating system's own font) and any fonts you have added.

## Add your own fonts

1. Open **Settings > Style** and press **Open fonts folder**. It is `fonts` inside your Nekko data folder (`~/.nekko-agent/fonts` unless you set `NEKKO_DATA_DIR`).
2. Copy `.ttf`, `.otf`, `.woff` or `.woff2` files into it.
3. Press **Reload fonts**. Each file shows up in both font lists under its file name: `My Font.ttf` becomes **My Font**.

Things to know:

- One file is one font. For a family with separate bold or italic files, add the variable-font file if the family has one, or name the file you want to use.
- Files over 16 MB, and anything that is not a font, are skipped. The first 64 fonts are loaded.
- Fonts stay on your machine. A paired phone keeps its own fonts.
- If you remove a font you were using, the app falls back to the default and the list shows it as missing.
- The built-in terminal keeps its own font list, so prompts that need Nerd Font symbols still draw.
