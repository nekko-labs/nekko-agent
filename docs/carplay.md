# Nekko Agent in CarPlay

> **Coming soon.** CarPlay apps need Apple's approval for their category. Nekko's CarPlay app is built, and it appears on your car's screen once Apple grants it and the update ships.

Your agents keep working while you drive. On the car's screen, Nekko Agent lists what is running on your computers, tells you what needs you, and does what you ask by voice. You never need to pick up your iPhone.

## Talk to Nekko

Open **Nekko** on the car's screen and it starts listening. Tap **Talk** at any time to say something else. You don't need to say "Nekko" first.

| Say | What happens |
| --- | --- |
| "What's happening?" or "What needs me?" | Nekko says how many chats need you and what for, then what is working. |
| "Read Billing" or "What did Billing say?" | Nekko reads that chat's latest reply aloud. |
| "Tell Billing to run the tests first" | Nekko reads it back. Say **yes** to send it. |
| "Allow", "Allow Billing", "Deny Billing" | Answers the step that chat is waiting on, after you say yes. With one approval waiting, you don't need the name. |
| "Stop the login chat" | Stops it after you say yes. Its work so far stays in the chat. |
| "Start a chat to look into the flaky test" | Starts a new chat on your computer with its default model, after you say yes. |
| "Yes", "No", "The second one", "Say that again" | Answers Nekko's question. |

You don't need a chat's exact name: "the login chat" finds "Fix flaky login test". If two chats sound alike, Nekko asks which one you mean.

**Talk inside a chat.** Tap a chat on the **Work** tab, then **Talk**. What you say goes straight to that chat, Nekko reads its answer aloud, and then it listens again. Say "no" or stay quiet to finish.

## What you see

- **Work**: every chat, on every paired computer, with what it is doing. The ones that need you come first.
- **A chat**: its status, the step it is on, and up to three buttons: **Allow** and **Deny** when it is waiting on you; **Talk**, **Hear latest** and **Stop** while it works.
- **Results**: everything your voice commands did on this drive, and how each one ended: sent, waiting until your computer is back, reply ready, or why it didn't work. Tap a row to hear it again.

Replies are read aloud and never shown on the car's screen. Apple doesn't allow it, and you are driving.

## Safety

- Anything that changes your work is read back first, and nothing happens until you say **yes**.
- **Allowing a tool needs your iPhone unlocked**, the same rule as on the Lock Screen. Deny and Stop work either way. High-risk steps can't be allowed from the car; they wait for you.
- From the car you act on chats on your active computer. You can still hear about chats on your other computers.
- Your voice is turned into text on your iPhone. If your iPhone can't do that for your language, your computer does it, the same as dictation. It never goes to a cloud speech service.

## If something doesn't work

- **"Microphone is off"**: Nekko Agent needs microphone access. You can turn it on in iPhone Settings → Nekko Agent once you're parked.
- **"Waiting to send"**: your computer is offline. Nekko keeps the message and sends it when the computer is back.
- **Nothing on the Work tab**: nothing is running. The list shows every chat the Lock Screen card would.
