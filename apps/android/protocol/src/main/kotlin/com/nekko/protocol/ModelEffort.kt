package com.nekko.protocol

// How hard a model works per turn, and which computers a chat's model can run
// on (T201a, the iPhone's `ModelEffort.swift` and New chat's Run on). Mirrors
// `modelEffortLevels` (packages/shared/src/model-capabilities.ts) and
// `LOCAL_PROVIDER_KINDS` (packages/shared/src/models.ts).

/** An effort level as the computer takes it in `session:setOptions` `effort` (`EffortLevel`). */
enum class Effort(val wire: String, val label: String) {
    LOW("low", "Low"),
    MEDIUM("medium", "Medium"),
    NORMAL("normal", "Normal"),
    HIGH("high", "High"),
    XHIGH("xhigh", "Extra high"),
    MAX("max", "Max");

    companion object {
        fun of(wire: String?): Effort? = entries.firstOrNull { it.wire == wire }

        private val CLAUDE = listOf(LOW, MEDIUM, HIGH, XHIGH, MAX)
        private val OPENAI = listOf(LOW, MEDIUM, NORMAL, HIGH)
        private val TEMPERATURE = listOf(LOW, NORMAL, HIGH)

        /** The levels worth offering for a model, lowest first. */
        fun levels(modelId: String?): List<Effort> = when {
            usesNativeEffort(modelId) -> CLAUDE
            isOpenAIReasoning(modelId) -> OPENAI
            else -> TEMPERATURE
        }

        /** Anthropic's `output_config.effort`: Claude from the 4.7 generation on, Fable and Mythos always. */
        fun usesNativeEffort(modelId: String?): Boolean {
            val c = claude(modelId) ?: return false
            if (c.first == "fable" || c.first == "mythos") return true
            return c.second > 4 || (c.second == 4 && c.third >= 7)
        }

        private val OPENAI_REASONING = Regex("""(?:^|[-_/ .])(?:o[134](?:-|$)|gpt-?(?:[5-9]|\d{2,})(?:[.\-]|$)|gpt-oss|codex)""", RegexOption.IGNORE_CASE)
        private val CLAUDE_ID = Regex("""^claude-(opus|sonnet|haiku|fable|mythos)-(\d+)(?:-(\d{1,2})(?!\d))?""")

        fun isOpenAIReasoning(modelId: String?): Boolean = OPENAI_REASONING.containsMatchIn(modelId.orEmpty())

        /** `parseClaudeModel`: family, major, minor; a gateway's `vendor/` and Bedrock's `anthropic.` prefixes stripped. */
        internal fun claude(modelId: String?): Triple<String, Int, Int>? {
            var id = modelId.orEmpty().lowercase().trim().substringAfterLast('/')
            val at = id.indexOf("anthropic.")
            if (at >= 0 && id.startsWith("claude-", at + "anthropic.".length)) id = id.substring(at + "anthropic.".length)
            val m = CLAUDE_ID.find(id) ?: return null
            return Triple(m.groupValues[1], m.groupValues[2].toInt(), m.groupValues[3].toIntOrNull() ?: 0)
        }
    }
}

/** On-device model servers: a chat on one runs on that computer's hardware, so New chat offers *Run on*. */
object LocalProviders {
    val KINDS = setOf("llamacpp", "ollama", "lmstudio", "vllm")

    fun isLocal(kind: String?): Boolean = kind in KINDS
}
