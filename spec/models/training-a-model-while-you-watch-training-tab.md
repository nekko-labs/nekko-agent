---
title: "Training a model while you watch (Training tab)"
area: models
split-from: SPEC.md (2026-10-22)
---

# Training a model while you watch (Training tab)

The user opens **Training**, says what the model is for ("classify support tickets by urgency"), points at a dataset (Hugging Face, Kaggle, a local path, or a URL) and optionally a base model, and hits Start. That's the whole simple path; an **Expert levers** panel exposes the full configuration (framework, epochs, batch size, learning rate, metric + direction, experiment/time budgets, free-form constraints) for people who want control. A **data-scientist agent** then does the real work in a dedicated chat session, and the dashboard shows its progression live: stat tiles (best score, experiments, success rate, emergent niches, self-repairs, runtime), a **current champion** card, and the **idea maze**, a growing tree of every idea the agent tried, color-coded (tried / got better / best so far / running) with the path to the leader highlighted. The user can **guide the agent mid-run**: hints, new training approaches, or corrections fold into its next turn. Starting a run drops the user straight onto its live dashboard, where a "now" strip spells out what's happening (from "starting up…" through the currently-running experiment), and an **Artifacts card** makes the output concrete: it lists exactly what the run built (the trained model plus each harness file), where each lives, and how to use it, with one-click open in the OS file manager. The distinctive twist: a run can also produce the **harness for the model's use case**, an agent file (AGENTS.md), a skill, and/or a spec, so the output isn't just weights, it's a ready-to-use capability.
