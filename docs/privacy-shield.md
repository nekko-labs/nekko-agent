# Privacy Shield

Privacy Shield controls what a chat sends to a cloud model. With it on, Nekko Agent replaces private values with placeholders like `[PII_EMAIL_1]` before a request leaves your computer. When the model answers, the real values are put back before anything runs or is shown. The model never sees the email address. The agent still writes the real one into your file, and you still read it in the reply.

Everything happens on your computer. Nothing is sent to another service to decide what is private.

## Turning it on

On desktop and the Local Web UI, open the composer's **Permissions** menu and select the **Privacy Shield** row. A checkmark on the left means it is enabled. The info button on the right explains the limits and links back to this guide; opening info does not change the setting. Incognito and Internet access have their own rows in the same menu.

In Detailed mode, the composer's existing **Shield** panel also offers **Shield this chat**, previews and category controls. The number beside Shield is how many values are being replaced. Native iOS and Android permission pickers have not gained these desktop rows.

The switch applies to that chat. Its sub-agents inherit it. To shield every chat that has no setting of its own, set `"privacyMode": "redact"` in `settings.json` (a Settings page for this is coming).

The shield only acts when the chat's model is off your computer: Anthropic, OpenAI, OpenRouter, Bedrock, Vertex, Foundry, ChatGPT, or a model server on another machine. A local model on this computer (the built-in engine, Ollama, LM Studio, vLLM) needs no shield, because nothing leaves the machine.

## What it replaces

| Kind | Example | Placeholder |
|---|---|---|
| Email addresses | `jane.doe@example.com` | `[PII_EMAIL_1]` |
| Phone numbers | `+81 90-1234-5678`, `(415) 555-0100`, `03-1234-5678` | `[PII_PHONE_1]` |
| Card numbers (Luhn-checked) | `4111 1111 1111 1111` | `[PII_CARD_1]` |
| US Social Security numbers | `123-45-6789` | `[PII_SSN_1]` |
| My Number (check digit verified) | `1234 5678 9018` | `[PII_MYNUMBER_1]` |
| Public IP addresses | `8.8.4.4` (never `127.0.0.1`, `10.x`, `192.168.x`) | `[PII_IP_1]` |
| API keys, tokens and passwords | `sk-ant-…`, `ghp_…`, `AKIA…`, `"password": "…"`, `DB_PASSWORD=…` | `[PII_SECRET_1]` |
| Your account name in file paths | `/Users/jane/…`, `C:\Users\jane\…` | `/Users/[PII_USER_1]/…` |
| Your own terms | `Acme Corp`, `Project Falcon` | `[PII_TERM_1]` |

**Your own terms** are the way to make a request generic: add your client's name, a codename or a person's name once, and every shielded chat sends a placeholder instead.

## Seeing what will be sent

While the shield is on and the chat uses a cloud model, the Shield icon is lit and a faint ring pulses around it. In the message you are writing, each value it will replace is tinted and bracketed, with its placeholder to the right: `[jane@acme.com] → [PII_EMAIL_1]`. The brackets and placeholder are only drawn on screen; they are not part of your message. A value you just typed is marked a moment after you stop typing.

Open the **Shield** panel at any time, on or off, to see:

- every value it would replace in your draft and the chat so far, what the model reads instead, and whether it is in your draft, the chat, or both;
- **Your message as the model reads it**, with the placeholders in place;
- the kinds it hides in this chat, each of which you can switch off;
- your terms, which apply to every chat.

Click **Send** on a value to send it as written in this chat (for example, a public support address you want the model to see). It moves to **Sent as written**, where **Hide again** undoes it.

## What it does not do

The shield finds values by pattern. It is a strong guard for structured data and secrets, not a guarantee:

- **Names and addresses in ordinary sentences** are not found unless you add them as terms.
- **Combinations can still identify someone.** A rare job title, a small town and a date can point to one person even with every name removed. Placeholders are pseudonyms, not anonymization.
- **Images** you attach are sent as they are.
- **Claude Agent chats** are sent by Claude Code itself, so the shield cannot reach them. The panel says so.
- **A version number like `1.2.3.4`** looks like a public IP and is replaced. The agent gets it back, but the model reads a placeholder.

Read the list before you send anything sensitive.

## Where the real values live

- The map from placeholder to value exists in memory for one reply and is then discarded. It is never written to disk.
- Your chat is saved with the real values, as before. Use **Incognito** if it should not be saved at all.
- The engine log records how many values of each kind were replaced, never the values.
