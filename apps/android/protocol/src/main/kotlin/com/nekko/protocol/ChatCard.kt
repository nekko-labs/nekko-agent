package com.nekko.protocol

import java.util.Locale

/**
 * What a chat row says under its title, as the desktop's agent card
 * (`WorkspaceCard.tsx`) says it: the provider's mark and the model ("Opus 5.5"),
 * how full the context window is while the chat is still in progress, and one
 * chip for its pull requests (the one that matters most, its state, and `+N`).
 * Ports of `shortModelName`, `guessContextWindow`, `fillTone`, `providerMarkKind`
 * and `primaryPr`; the iPhone's `ChatCard.swift`, held to the same tests.
 */
object ChatCard {
    internal data class ClaudeId(val family: String, val major: Int, val minor: Int)

    private val claudePattern = Regex("""^claude-(opus|sonnet|haiku|fable|mythos)-(\d+)(?:-(\d{1,2})(?!\d))?""")

    /** A Claude id as family and version, past a gateway's `vendor/` and Bedrock's `anthropic.` prefixes. */
    internal fun parseClaude(id: String?): ClaudeId? {
        var s = (id ?: "").lowercase(Locale.ROOT).trim().substringAfterLast('/')
        val at = s.indexOf("anthropic.")
        if (at >= 0 && s.substring(at + "anthropic.".length).startsWith("claude-")) s = s.substring(at + "anthropic.".length)
        val m = claudePattern.find(s) ?: return null
        return ClaudeId(m.groupValues[1], m.groupValues[2].toIntOrNull() ?: 0, m.groupValues[3].toIntOrNull() ?: 0)
    }

    /** The model as a card line: "Opus 5.5" for a Claude id, else the id without its vendor, `:latest` or date. */
    fun modelName(id: String): String {
        val c = parseClaude(id) ?: return AgentRows.shortModelName(id)
        val family = c.family.replaceFirstChar { it.titlecase(Locale.ROOT) }
        return if (c.minor > 0) "$family ${c.major}.${c.minor}" else "$family ${c.major}"
    }

    /**
     * The provider mark for a chat: a key (`anthropic`, `openai`, `google`, `openrouter`,
     * `ollama`, `lmstudio`, `vllm`) or null for none. The provider's kind decides when
     * the phone knows it, as on the desktop; a custom endpoint gets no mark. Without
     * the kind, a model id that can only be one vendor's names it.
     */
    fun providerMark(kind: String?, modelId: String?): String? {
        if (!kind.isNullOrEmpty()) return when (kind) {
            // The phone's own Bedrock and Foundry providers serve only Claude.
            "anthropic", "claude-code", "bedrock", "foundry" -> "anthropic"
            "openai", "chatgpt", "codex" -> "openai"
            "gemini", "vertex" -> "google"
            "openrouter" -> "openrouter"
            "ollama", "ollama-cloud" -> "ollama"
            "lmstudio" -> "lmstudio"
            "vllm" -> "vllm"
            else -> null
        }
        val id = (modelId ?: "").lowercase(Locale.ROOT)
        if (id.isEmpty() || '/' in id) return null
        if (parseClaude(id) != null || id in setOf("opus", "sonnet", "haiku") || id.startsWith("claude")) return "anthropic"
        if (id.startsWith("gpt-") || id.startsWith("chatgpt") || Regex("""^o[134](?:$|-)""").containsMatchIn(id)) return "openai"
        if (id.startsWith("gemini")) return "google"
        return null
    }

    /** The model's context window when the computer did not say: the desktop's `guessContextWindow`. */
    fun guessContextWindow(modelId: String?): Long {
        val id = (modelId ?: "").lowercase(Locale.ROOT)
        if (id.isEmpty()) return 128_000
        parseClaude(id)?.let { c ->
            if (c.family == "fable" || c.family == "mythos") return 1_000_000
            if (c.family == "haiku") return if (c.major >= 5) 1_000_000 else 200_000
            return if (c.major > 4 || (c.major == 4 && c.minor >= 6)) 1_000_000 else 200_000
        }
        if (id in setOf("opus", "sonnet", "haiku")) return 1_000_000
        if ("claude" in id) return 200_000
        if ("gemini" in id) return 1_000_000
        if (Regex("""(?:^|/)gpt-5\.6-(?:sol|terra|luna)(?:$|[-/])""").containsMatchIn(id)) return 272_000
        if (Regex("""(?:^|/)gpt-5(?:-(?:mini|nano|codex))?(?:$|-\d{4}-\d{2}-\d{2}$)""").containsMatchIn(id)) return 400_000
        if ("gpt-4.1" in id) return 1_047_576
        if (Regex("""(?:^|/)o[34](?:$|[-/])""").containsMatchIn(id)) return 200_000
        return 128_000
    }

    /** How full a window is, in the desktop's three hues: room (green), filling (amber), nearly full (red). */
    enum class Fill { ROOM, FILLING, FULL }

    fun fill(used: Long, window: Long): Fill {
        if (window <= 0) return Fill.ROOM
        val pct = used.toDouble() / window * 100
        return if (pct >= 85) Fill.FULL else if (pct >= 60) Fill.FILLING else Fill.ROOM
    }

    /** The gauge's words, `45k/1M`, and how full it is. */
    data class Context(val used: Long, val window: Long, val text: String, val fill: Fill) {
        val percent: Int get() = if (window > 0) Math.round(used.toDouble() / window * 100).toInt() else 0
    }

    /** The chat's context gauge, or null when nothing is used yet. */
    fun context(s: SessionSummary): Context? {
        val used = (s.contextUsed ?: s.transcriptTokens)?.takeIf { it > 0 } ?: return null
        val window = s.contextWindow ?: guessContextWindow(s.modelId)
        return Context(used, window, "${compactTokens(used)}/${compactTokens(window)}", fill(used, window))
    }

    /**
     * Context matters while the chat is in progress: running, waiting on you, or
     * idle with a watch armed. A finished or completed chat has no context
     * pressure left, so its card leaves the gauge off.
     */
    fun showsContext(s: SessionSummary, activity: Activity?): Boolean =
        !s.archived && (activity != null || s.activeWatchCount > 0)

    /** "4.5k" / "312k" / "1M": the desktop card's `compactTokens`. */
    fun compactTokens(n: Long): String {
        fun trim(s: String) = if (s.endsWith(".0")) s.dropLast(2) else s
        return when {
            n >= 1_000_000 -> trim(String.format(Locale.ROOT, "%.1f", n / 1_000_000.0)) + "M"
            n >= 10_000 -> String.format(Locale.ROOT, "%.0f", n / 1000.0) + "k"
            n >= 1000 -> String.format(Locale.ROOT, "%.1f", n / 1000.0) + "k"
            else -> n.toString()
        }
    }

    /** A PR's state as GitHub shows it: a draft is an open PR that is not ready. */
    enum class PrStatus { OPEN, DRAFT, MERGED, CLOSED }

    fun prStatus(pr: PullRequest): PrStatus = when (pr.state) {
        PullRequest.State.MERGED -> PrStatus.MERGED
        PullRequest.State.CLOSED -> PrStatus.CLOSED
        PullRequest.State.OPEN -> if (pr.isDraft) PrStatus.DRAFT else PrStatus.OPEN
    }

    /** The repository a PR belongs to: its URL up to `/pull/` (or GitLab's and Bitbucket's equivalents). */
    internal fun repo(pr: PullRequest): String {
        for (marker in listOf("/pull/", "/-/merge_requests/", "/pull-requests/")) {
            val i = pr.url.indexOf(marker)
            if (i >= 0) return pr.url.substring(0, i)
        }
        return pr.url
    }

    /**
     * The PR a row's chip shows when a chat has several: still in flight over done
     * (open, draft, merged, closed), then the newest. Numbers only order PRs within
     * one repository; ties keep the given order.
     */
    fun primaryPr(prs: List<PullRequest>): PullRequest? {
        var best: PullRequest? = null
        for (pr in prs) {
            val b = best
            if (b == null) { best = pr; continue }
            val r = prStatus(pr).ordinal - prStatus(b).ordinal
            if (r < 0 || (r == 0 && pr.number > b.number && repo(pr) == repo(b))) best = pr
        }
        return best
    }
}
