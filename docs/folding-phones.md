# Two chats on a folding phone

> **Not yet tested on a real foldable.** The Devs don’t have a foldable phone to test this one, so we tried our best without one! If you see any issues, please [let us know](https://github.com/nekko-labs/nekko-agent/issues/new) 🙏

Unfolded, a Galaxy Z Fold, a Pixel Fold, a OnePlus Open or a Surface Duo is a small, nearly square tablet. The Nekko Agent apps for iPhone and Android use that space for **two panes**: watch two chats run side by side, or keep your computer's **Monitors** next to a chat. It works whether you hold the phone wide or tall, half-folded on a table, or closed to its outer screen. The same layouts work on an iPad.

Two panes are two views of one paired computer. Everything you can do in a chat works in either pane, and the computer's rules for phones (the Read and Change switches, Face ID for raising a chat's mode, and a [security key](security-keys.md) when you use one) apply to each pane as before. Nothing new is stored on the computer: the arrangement you pick lives on the phone.

## Postures

The app follows how you hold the phone, read from the system, not from a list of models:

| Posture | For example | What you see |
| --- | --- | --- |
| **Closed** (the outer screen) | A Fold's cover screen, a Flip closed, any ordinary phone | The usual one-column app. |
| **Open, wide** | A Fold, Pixel Fold or folding iPhone open and held wide | **Two panes side by side**, the divider on the hinge. |
| **Open, tall** | A Fold open and turned, a Surface Duo held tall | **Two panes stacked**: your main chat on top, the second chat or Monitors below. |
| **Tabletop** (half-folded, hinge across) | A Flip or Fold resting on a table | The chat you are typing in fills the screen: the conversation on the upper half; the message box, approval cards and the keyboard on the lower half. Nothing sits on the fold. |
| **Book** (half-folded, hinge down the middle) | A Fold held like a book | As open, wide; the divider snaps to the hinge. |

A screen under 600 points wide always gets the one-column app, so a Flip's inner screen in portrait stays one column, as does a big phone on its side.

Changing posture moves the panes rather than starting over: a chat on the right stays scrolled where it was when it moves to the bottom. Closing the phone takes you to the one-column app on the chat you were in; opening it again brings back your last arrangement.

## Arrangements

Each pane holds one thing: a **chat**, **Monitors**, the **chat list**, **New chat**, or another screen (Files, Git, Terminals, Settings). Pick an arrangement from a pane's header menu, or drag a chat from the list onto a pane:

- **Chats + Chat**: the chat list beside one chat. This is where you start, and what an iPad shows today.
- **Chat + Chat**: two chats at once. The first time you open a second chat while one is running, a one-line tip offers it.
- **Chat + Monitors**: a chat beside your computer's Monitors.
- **Monitors + Chats**: Monitors beside the chat list.

Held tall, the chat list never goes in the bottom pane (a list under a chat reads like the chat's attachments): *Chats + Chat* becomes a chat over Monitors, and the top pane's back button takes you to the list.

The last arrangement and what was in it are remembered **for each computer** you have paired.

### The pane header

Each pane's header shows its chat's title, the status dot and the usual chat menu, plus:

- **Swap**: the two panes trade places.
- **Focus**: that pane fills the screen and the other folds to a tab at the edge. Tap the tab to bring it back.
- **Replace with…**: put Monitors, the chat list or another chat in this pane.

Drag the divider to give one pane more room, between about a third and two thirds. On a phone with a hinge the divider stays on the hinge.

### Typing in two chats

Only the pane you tapped last takes the keyboard. The other pane shrinks above it, so you can still read it. Each chat has its own message box, queue and approvals: sending in one never touches the other.

When the other pane needs you (a tool waiting for **Allow**, or a question), its status dot pulses and the card appears at the bottom of that pane. Allowing works as it does in a single chat: the phone must be unlocked. Lock Screen activities and notifications are unchanged.

### Dragging between panes

Drag a message, a file from Files, or an image from one pane into the other pane's message box. It is inserted as a draft; nothing is sent until you send it.

## Monitors

Monitors is the phone's view of what your computer is doing, like the desktop's Agent Monitor. It is read only, and has four parts:

- **Hardware**: CPU, GPU and memory load, and temperatures where the computer has sensors.
- **Running**: every chat that is working, what it is doing (working, waiting for approval, or asking a question) and for how long. Tap one to open it in the other pane.
- **Needs you**: approvals and questions from every chat, oldest first, with **Allow**, **Deny** or an answer right there. They go through the same checks as in the chat itself.
- **Automations**: the next scheduled runs.

Monitors refreshes from what the phone already hears, plus one small request every 10 seconds while it is on screen. It never polls in the background. What it shows is trimmed for a phone: no process names, no file paths, and never a tool's input. With **Read** switched off for the phone, it says *read is off for this phone*.

Monitors is not only for foldables: on a closed or ordinary phone it is a tab at the bottom of the chat list.

## What it does not do

- **Two computers at once.** Both panes talk to the same computer; the app holds one connection.
- **Three panes.** On a big tablet, use the desktop's Agent board instead.
- **The Apple Watch** has no fold layout, and the older Expo app does not get panes.
- With the app lock on, the privacy cover hides both panes.

See also [Phone remote control](REMOTE.md) for pairing and what a paired phone may do.
