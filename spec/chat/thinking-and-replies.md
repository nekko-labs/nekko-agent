---
title: "Thinking and replies"
area: chat
---

# Thinking and replies

User intent: in a long agent turn, tell the agent thinking apart from the agent talking to you. Reasoning, progress notes and the closing reply used to read the same, so the reply was easy to skim past, and a question or a step left for the person got lost further up the turn ([#1574](https://github.com/nekko-labs/nekko-agent/issues/1574)).

## How a block reads

- `[implemented; focused tests and hidden desktop captures at 1500px and 700px]` **Thinking is quiet.** Reasoning and progress notes between steps use the soft ink colour with the thought icon on their left, in the transcript's gutter.
- `[implemented; focused tests and hidden desktop captures]` **The reply stands out.** The message that closes a turn that made tool calls sits on a soft accent panel with a bar on its left. A reply with no steps before it has nothing to stand out from, so ordinary conversation stays plain prose.
- `[implemented; focused tests and hidden desktop captures]` **What is left for you stands out wherever it is.** A mid-turn message that names a topic, or that stops on a question, sits on an attention panel instead of reading as a note. A note that only asks itself something in passing stays quiet.
- `[implemented; focused tests and hidden desktop captures]` **A note is not the end of anything.** Notes between steps no longer say Done, and no longer repeat the reasoning their step already shows.
- `[implemented; column positions measured in the hidden captures, voice settling covered by focused tests]` **Text does not move.** While a turn runs, its newest text has no voice yet, because it may be a note or the reply. It settles when more follows it or the turn ends. The icon and the panel live in the gutter, so settling changes the look without re-wrapping the text.

## Topic headers

- `[implemented; focused tests and hidden desktop captures]` A line of its own that names a topic, as a Markdown heading or a bold label, is drawn as a header with an icon: questions, next steps and actions, commands to run, decisions and assumptions, and summaries (Summary, Changes, Verified, Not verified / blocked). Words after the label become the section's first line. The icon carries the colour, and only what asks something of the reader is loud.
- `[implemented; focused tests and hidden desktop captures]` A settled message that closes on a question with no label gets a Question header. It only applies to replies and mid-turn messages, not to ordinary conversation, where ending on a question is just how people talk.
- `[implemented; golden fixtures, not checked against live models]` The system prompt asks every model to use these labels in any message of a turn, and to end a message with its question.

Topics are read from the text the model wrote, with no model call and no change to what is stored. Copy and Find in this chat keep working on the original text. Only agent text is read this way: your own messages and reasoning render as before.

## Limits

- `[planned, TASKS VOICE-3]` The iOS and Android transcripts still draw notes and replies alike, and show labels as bold text.
- Labels are recognised in English. A reply in another language gets its panels and the closing question header (`？` counts), but a translated label stays bold text.
- A model that ignores the labels still gets the panels and the closing question header, not the other headers.
