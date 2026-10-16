# Review: skills dall'app Android

Data: analisi del worktree corrente (HEAD committato). Nessun codice modificato.

## Risposta breve

**No, oggi da Android non si possono usare le skills.** L'app sa solo *mostrare* un messaggio
inviato con una skill da un altro client (`/nome input`), ma non può elencarle né invocarle.
E anche se inviasse il campo `skill`, il computer non farebbe nulla di diverso: oggi la skill
viene "espansa" dal client desktop, non dal computer.

## Cosa c'è oggi

| Pezzo | Stato | Dove |
|---|---|---|
| Visualizzare un messaggio con skill nel transcript | ✅ c'è | `apps/android/protocol/.../Wire.kt:114` (`ChatMessage.skill`), `Transcript.kt:53` |
| Elencare le skills del PC dal telefono | ❌ manca | nessun canale skills in `PHONE_CHANNELS` (`packages/shared/src/phone-access.ts`) né in `Wire.kt` `Channels` |
| Menu `/` / scelta skill nel composer Android | ❌ manca | `app/.../ui/chat/Composer.kt` |
| Invio di una skill da Android | ❌ manca | `ChatController.send(text)` manda solo testo, in coda solo stringhe |
| Campo `skill` in `chat:send` permesso al telefono | ✅ già permesso | `PHONE_CHAT_SEND_KEYS` include `skill`; `phone-access.json:94` |

### Come funziona la skill sul PC (il punto importante)

Nel desktop (`apps/desktop/src/renderer/components/ChatPane.tsx:1444-1516`) il **renderer**:

1. carica le skills con `skills:installed` + `skills:external` e il catalogo built-in `SKILLS`
   (`packages/shared/src/skills.ts`), unendo marketplace e skill importate da Claude/Codex/Gemini
   (`store.ts:714-731`);
2. all'invio costruisce `text = template + "\n\n" + input`;
3. manda `chat:send` con `text` già espanso **più** `skill: {name, input}` solo come etichetta.

L'host (`packages/host/src/turn-plan.ts:185`) e il daemon Rust (`crates/nekko-turn/src/input.rs:63`)
salvano `skill` sul messaggio ma **non risolvono il template**. Quindi il telefono non può
semplicemente mandare `skill`: deve ricevere il testo espanso da qualcuno.

`/goal` è speciale: il desktop non manda una chat ma crea un task in background (`createTask`),
canale non permesso al telefono.

## Proposta

**Principio: le skills restano solo sul PC.** Il telefono non ne copia nessuna: le chiede al
computer quando servono. Così è sempre sincronizzato per costruzione (installi/rimuovi una skill
sul PC → la prossima apertura del menu `/` sul telefono la riflette).

### Lato computer (TS host + daemon Rust, in parità)

1. **Nuovo canale `skills:runnable`** (lista completa per il computer, ridotta per il telefono dal gate) che restituisce una vista ridotta:
   `{ name, description, category, source }` dove `source` ∈ `builtin | marketplace | claude | codex | gemini | agents`.
   **Niente template, niente percorsi** (`origin.dir` e l'intro delle skill esterne contengono path
   assoluti del PC). Stesso modello di redazione già usato per `providers:list`/`settings:get`.
2. **Espansione sul computer per i `chat:send` dal telefono:** se arriva `skill: {name, input}`,
   il gate del telefono risolve il template per nome dalla stessa lista del desktop
   (built-in → marketplace → esterne, built-in vince sui conflitti come `matchSkills`) e imposta
   `text = template + input`. Skill sconosciuta → errore chiaro (`skill-unknown`), niente invio
   silenzioso. Stessa cosa per `chat:queue` con payload `{text, skill}`.
   - Sicurezza: non aggiunge privilegi, il telefono può già mandare qualsiasi `text`; i template
     non lasciano mai il PC.
3. `/goal` escluso dalla lista telefono (richiede `task:create`, non permesso) — salvo tua scelta.
4. Parità: `phone-access.ts` → `phone-access.json` (golden), gate Rust
   `crates/nekko-remote/src/phone.rs` + daemon (`crates/nekkod/src/workspace.rs` ha già
   `skills:installed`/`skills:external`). Da verificare: il catalogo built-in `SKILLS` e il
   catalogo marketplace esistono solo in TS; per il daemon serve una fonte condivisa
   (JSON generato dal golden test, come già fatto per `phone-access.json`).

### Lato Android

1. `Wire.kt`: canale `SKILLS_PHONE`, decoder `SkillSummary`; test di parità dei canali.
2. `ChatController.send(text, skill?)` e coda con `{text, skill}`.
3. Composer: digitando `/` all'inizio si apre un elenco filtrabile (stessa logica di `matchSkills`),
   la skill scelta appare come chip rimovibile sopra il campo; Invio manda `skill + input`.
   Lista ricaricata a ogni apertura del menu (o alla connessione), con stato "computer offline".
4. Il transcript mostra già `/nome input`.

### Verifica prevista

- Unit test TS (gate, espansione, redazione: niente template/path nella risposta), golden
  `phone-access.json`, `cargo test -p nekko-remote` / daemon.
- JVM test Android (decoder, controller con skill, filtro del menu).
- Emulatore API 37 contro un agente sandbox: screenshot light/dark del menu `/` e di un invio
  (schermata nuova → nessun "before" per il menu), registrazione breve dell'apertura menu.
- `SPEC.md`, `TASKS.md` (nuovo AN-16), `apps/android/README.md`, docs.

## Fuori scope (proposto)

- Installare/rimuovere skills dal telefono (resta sul PC: `skill:install` scrive su disco).
- iOS e app Expo (stessa API, lavoro separato).
- Mostrare il contenuto completo delle istruzioni di una skill sul telefono.

## Rischi / incognite

- Parità daemon Rust: dove vive il catalogo built-in/marketplace lato Rust va verificato prima di stimare.
- Skill esterne con file propri (script): l'intro indica la cartella sul PC; va bene perché il
  lavoro gira sul PC, ma il path resta solo nel testo inviato al modello, non nella vista telefono.


## Esito (implementato)

Decisioni prese: espansione sul PC, `/goal` escluso, solo uso (no installazione dal telefono). Implementato come proposto con il canale `skills:runnable`; vedi la sezione di SPEC.md "The computer's skills from the phone".
