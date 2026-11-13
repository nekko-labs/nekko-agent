# Fusion routing and model tiers

Use **Auto · this provider** when Nekko may choose a model but must stay on the selected provider/account. Use **Fusion** when replies and subagents may use other configured providers. A saved local subagent preference does **not** turn Fusion on.

## Choose a routing strategy

1. Open the chat's model picker and select **Fusion → Fusion** (or the Fusion row in All).
2. Open the **Fusion** control beside the model chip to change the strategy. The same setting is in **Settings → Agents → Fusion routing**.
3. Choose Balanced, Economical, Quality first, Local first, or Capacity fallback.

Balanced chooses a suitable capability level, then value. Economical prioritizes known per-turn cost among suitable models. Quality first prefers the strongest tier. Local first prefers a suitable local model, not an undersized one. Capacity fallback stays on the current provider while it can serve. Selection uses deterministic rules, with no extra classifier-model call. The route reason explains the choice.

Strategy is shared by Fusion chats; permission to switch providers is per-chat. Picking a concrete model or **Auto · this provider** turns switching off for that chat. Cloud-only/offline/incognito restrictions still apply and are not cleared by Fusion.

## Classify your models

In **Settings → Agents → Fusion routing → Model capability tiers**, search for a model and choose **Small**, **Medium**, **Large**, or **Frontier**. The tier describes relative capability for your workload, not model file size.

Nekko suggests a tier from known model families and parameter-count labels. The suggestions are heuristics, not benchmark measurements. A manual selection is labelled **Your classification**; **Reset to suggested** removes the override. Classifications are scoped to the configured provider/account, so two local servers can classify the same model name differently. Unknown models stay **Unclassified** until you assign a tier; you can still pick one explicitly.

## Example: Medium local subagents

1. Classify your local coding model as **Medium**, if the suggestion is missing or wrong.
2. In the model picker's **Subagents** section (also in Settings → Agents), set **Capability target → Medium** and select **Auto · prefer local**.
3. Enable **Fusion** in chats where using a different provider is allowed.

Automatic delegates choose the target tier, then the nearest smaller available tier, and never exceed the parent automatically. With several local providers, the requested tier wins over a smaller model on the first provider. Default Auto only considers already-loaded local models; prefer-local may use an unloaded one.

Without Fusion, those preferences stay on the chat's provider. A specific saved or agent-requested model on another provider is refused visibly instead of silently substituted. If no eligible automatic pick is available, the child inherits the parent model. **Same model as the chat** and exact picks remain available.

## Scope

These controls are implemented in the shared desktop/local-web renderer. The daemon enforces delegation permission, tier selection and saved-route/resume checks. Native phone clients do not yet edit these settings. Headless messaging keeps its existing same-provider Auto behavior. Claude Code's own subagents use its existing environment mechanism (Small/Medium/Large map to Haiku/Sonnet/Opus; Frontier caps at Opus), but live CLI compliance has not been verified. No model-based classifier or measured-latency routing is claimed.
