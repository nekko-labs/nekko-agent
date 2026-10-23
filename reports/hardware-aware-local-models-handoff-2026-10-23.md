# Modelli locali consapevoli dell'hardware: passaggio di consegne (2026-10-23)

Passaggio di consegne datato, non un cruscotto di stato aggiornato. Prima di riprendere, ricontrolla su GitHub lo stato delle PR e leggi `AGENTS.md`.

L'issue originale ha due parti:

- **Parte A:** scegliere da sole i modelli locali giusti per questa macchina.
- **Parte B:** far girare le automazioni con modelli locali senza disturbare chi usa il computer.

L'abbiamo divisa in sei livelli:

| Livello | Contenuto | Stato |
|---|---|---|
| A1 | Profilo hardware e feed incluso nell'app | ✅ in `main` (#860) |
| — | Planner del motore: cache KV per layer | ✅ in `main` (#864) |
| A2 | UI "Best for this machine" con velocità attese | ✅ in `main` (#866) |
| A3a | Velocità misurate in locale che sostituiscono la stima | 🟡 #877, base `main`, in coda |
| A3b | Suggerimenti di upgrade | 🟡 #878, impilata su #877 (base `nekko/a3a-measured-speeds`) |
| B1 | Segnali di attività e politiche | ⬜ da fare |
| B2 | Preemption, con le misure e la voce in `perf-history.md` | ⬜ da fare |
| B3 | Residenza dei modelli e chip del monitor | ⬜ da fare |

Quando #877 entra in `main`, la base di #878 va spostata su `main` e #878 va riallineata (`git rebase --onto origin/main <commit A3a> nekko/a3b-upgrade-nudges`), perché la coda squasha. `gh stack` non è installato: lo stack è fatto a mano con `--base`.

## Cosa esiste adesso (parte A)

### Daemon (`crates/nekko-machine`, `crates/nekkod`)

- **`profile.rs`**: il profilo hardware (`machine:profile`).
  - Contiene GPU con VRAM e core Apple, RAM, CPU, backend, build del motore e disco libero.
  - È salvato in `<data>/machine-profile.json` e riusato per 7 giorni, oppure finché non cambia la build del motore; `{ refresh: true }` lo rifà.
- **`recommend.rs` + `src/model-feed.json`**: per ogni compito (chat, code, router, embedding, vision) dà la scelta, la memoria, il margine e la velocità con la sua base. I canali sono `machine:recommendations` e `machine:dismissNudge`.
  - **Budget:** la GPU più capiente meno 1 GiB; su Apple Silicon 2/3 della RAM fino a 36 GB e 3/4 sopra; RAM meno 4 GiB sulla CPU.
  - **Quantizzazione:** vince quella più alta che sta comoda (≤75% del budget) ed è abbastanza veloce, poi quella al limite (≤90%), poi la più veloce che ci sta.
  - **Base della velocità:** `measuredHere` (mediana delle risposte locali), `measured` (feed, stesso file e stessa classe hardware), `estimated` (efficienza × banda ÷ byte per token), `estimatedBorrowed` (efficienza presa da un altro backend), nessuna per una GPU sconosciuta.
  - **Efficienze misurate:** CUDA 0,52 (dal benchmark RTX 5090 in `docs/benchmarks.md`), Metal 0,60 sui densi e 0,46 sui MoE (M5 Max). Vulkan, HIP e CPU le prendono in prestito.
  - **`downloadLabel`:** l'etichetta del catalogo (senza `UD-`), da passare a `engineDownloadModel`.
- **`measured.rs` + `nekkod/src/speeds.rs` + meter in `nekko-infer/src/router.rs`** (A3a): il router legge i `timings` di llama-server dalla coda della risposta. Valgono le risposte con il modello tutto per sé e almeno 32 token. Si salvano in `<data>/measured-speeds.json`, per file e per macchina, le ultime 20; con 3 o più, la mediana sostituisce la stima.
- **`nudges.rs`** (A3b): ricorda in `<data>/recommendations-seen.json` le scelte già viste. Un suggerimento compare solo se hai un candidato di quel compito messo peggio in classifica e la scelta è cambiata (feed nuovo o macchina nuova).
- **Planner del motore** (`nekko-engine/src/gguf.rs`, `capacity.rs`):
  - `KvLayout` letto dalla tabella dei tensori;
  - i layer ricorrenti (`ssm_*`) e quelli con KV condivisa non tengono cache;
  - i layer a finestra si fermano alla finestra più 512;
  - con 1 slot llama-server usa 4 sequenze unificate (`--parallel` auto), con N slot divide il contesto.

  Verificato esatto contro llama-server b11429 su Gemma 4 12B, Qwen3.5 4B e Qwen3.6 35B A3B.

### UI (`apps/desktop/src/renderer/components/engine/`)

- `RecommendedModels.tsx` (blocco e scheda dei suggerimenti) e `recommendationText.ts` (testi), montati in `ModelsHome.tsx`.
- Prove visive: `node apps/desktop/scripts/recommendations-integration.cjs`. Gira in una finestra nascosta e offline, con i dati in `recommendations.fixture.json`. `NEKKO_TEST_REVISION=origin/main` cattura il "prima".

### Script e verifiche utili

- `node scripts/model-feed.mjs [--keep]`: ricostruisce il feed da `crates/nekko-machine/feed/source.json`. `--keep` riusa i dati dei file non cambiati.
- `node scripts/itest-recommendations.mjs`: cosa riceve la macchina su cui gira. Da usare su Windows/NVIDIA, AMD e solo CPU.
- `NEKKO_KV_CHECK_DIR=<cartella modelli> cargo test -p nekko-engine --test kv_layout -- --ignored`: la cache KV confrontata sui file reali.
- `cargo test -p nekko-infer --release --test router -- --ignored --nocapture meter_cost`: il costo del meter.
- In `/tmp/nekko-feed-bench/models` ci sono circa 32 GB di modelli scaricati per le misure (Gemma 4 12B, Qwen3.5 4B, Qwen3.6 35B A3B). Si possono cancellare.

Documenti: spec `spec/models/hardware-aware-model-recommendations.md` e `spec/models/models-providers.md`, decisioni `docs/decisions/0002-…` e `0003-…`, voce T193 in `TASKS.md`, `docs/local-models.md`.

## Decisioni aperte (servono a Davide)

1. **Ordine editoriale dei modelli** (`crates/nekko-machine/feed/source.json`). Va rivisto con la UI davanti. Domande già poste:
   - chat su macchine potenti: qualità (Qwen3.8 27B denso, ~23 tok/s sull'M5 Max) o velocità (soglia a 30, così vincono i MoE come Qwen3.6 35B A3B, 108 tok/s misurati)?
   - coding su GPU da 24–32 GB: Devstral Small 2 24B prima di Qwen3 Coder 30B A3B?
   - solo CPU: mostrare coding e visione anche sotto soglia, o non mostrarli?
2. **Condivisione anonima opt-in delle velocità (T193i).** Le opzioni sono nella sezione sotto.
3. **Verifica AMD.** Nessuno ha una GPU AMD, e le velocità Vulkan restano "rough" finché non vengono misurate.

### T193i: come si potrebbe fare la condivisione

- **Cosa inviare (proposta minima):** versione del feed, id del modello e quantizzazione (solo modelli del feed, mai nomi di file arbitrari), classe hardware del feed (es. `nvidia-rtx-4080`, mai il nome libero della GPU), backend e build del motore, mediana dei tok/s e numero di campioni, contesto arrotondato a fasce.
- **Cosa non inviare mai:** prompt, testi, nomi di file locali, percorsi, nomi macchina, IP conservati.
- **Dove:** un endpoint su Nekko Cloud (`apps/nekko-agent-api`; dove gira e su quale database è da verificare, vedi #862). In alternativa un file per release raccolto via GitHub, ma è peggio.
- **Consenso:** spento di default. Un interruttore nelle impostazioni (la sezione è da decidere) con anteprima esatta del JSON prima dell'invio. Invio in batch al più una volta al giorno; disattivandolo si cancella anche la coda locale.
- **A cosa serve:** le mediane aggregate per classe hardware entrano in `measured` del feed, previa revisione umana e con una soglia minima di invii per classe.

## Problemi trovati, fuori dallo scope e non risolti

- Una cartella modelli fatta di link simbolici non mostra nessun modello in libreria (anche su `main`).
- `apps/desktop/scripts/local-models-panel-integration.cjs` estrae solo `src/renderer` per il "prima" e fallisce contro `main`: il renderer importa `src/displayWindows.ts`. Lo script delle raccomandazioni estrae tutto `apps/desktop/src`.
- Nella suite vitest completa, `bundleExternals` e `relay-bundle` richiedono `apps/desktop/out/`, e `PaneFrame.test.tsx` si aspetta `Ctrl` ma su macOS riceve `Cmd`.
- Lo stato ricorrente dei modelli ibridi (50–250 MiB) non è contato a parte, e i modelli di Ollama restano sulla formula KV uniforme. Entrambi sono in TASKS.
- Nella scheda dei suggerimenti, due compiti con la stessa scelta (coding e visione) danno due righe.
- I "nuovi feed" arrivano solo con gli aggiornamenti dell'app finché non c'è l'aggiornamento online firmato (T193f). Lo schema da riusare è il documento firmato di `crates/nekkod/src/claude_policy.rs`.

## Prossimi passi: parte B

Oggi **nel codice non c'è nessun rilevamento di inattività** (nessun `powerMonitor`, `GetLastInputInfo` o `CGEventSource`).

### B1: segnali di attività e politiche

- **Segnali:**
  - tempo di inattività dell'OS: macOS `CGEventSourceSecondsSinceLastEventType`, Windows `GetLastInputInfo`, Linux da decidere (X11/Wayland);
  - app in primo piano a schermo intero o gioco;
  - batteria e batteria scarica;
  - stato termico (`crates/nekko-machine/src/temps.rs` legge già le temperature);
  - uso della GPU da parte di altri processi (`gpu:stats` dà l'uso totale);
  - una chat Nekko attiva.
- **Dove:** nel daemon (Rust), così funziona anche senza desktop. Electron ha `powerMonitor`, ma il daemon deve decidere da solo.
- **Politiche per automazione**, con un default globale: Solo quando inattivo (default), Bassa priorità, Sempre. Le automazioni sono in `crates/nekko-automation` e `crates/nekkod/src/automation.rs`.
- **Test:** un segnale di input sintetico (richiesto dall'accettazione).

### B2: preemption

- **Obiettivo:** quando l'utente torna, l'inferenza in background deve cedere entro circa 1 secondo e ripartire quando è di nuovo inattivo.
- **Leve disponibili:**
  - fermare le richieste in arrivo al router (`nekko-infer`; il supervisor conta già le richieste attive, `Child::active_requests`);
  - interrompere la generazione chiudendo la connessione upstream (il router lo fa già quando il client chiude);
  - kill e restart di llama-server (libera memoria, perde la cache KV) contro throttling (mantiene la cache, ma cambiare layer o slot richiede un ricaricamento).
- **Da misurare e registrare in `docs/perf-history.md`:** latenza di cessione e costo della ripresa.

### B3: residenza e chip del monitor

- Tenere caldo un modello piccolo per il routing ed espellere quello grande sotto pressione di memoria, coordinandosi con `idleTtlSeconds` (default 900) e `maxLoaded` (default 2) in `packages/shared/src/engine.ts`, e con lo sweep in `nekko-engine/src/server.rs` (`sweep_idle`).
- Mostrare lo stato nel chip del monitor, es. "Background: paused, you're active" (`ResourceMonitor.tsx`, `MonitorsDock.tsx`).

## Regole del repo da ricordare

- Mai attribuzione AI in commit e PR (`AGENTS.md`), nemmeno se lo strumento la suggerisce.
- PR **ready** e `gh pr merge --auto`. Draft solo con un bloccante di rilascio dichiarato.
- Ogni cambio visibile richiede screenshot prima/dopo, caricati con `node scripts/pr-media.mjs <n>`.
- Spec e documentazione si aggiornano nella stessa PR, e `node scripts/spec-index.mjs` va rilanciato dopo aver aggiunto uno spec.
- Ogni cambio di prestazioni misurato va registrato in `docs/perf-history.md`.
