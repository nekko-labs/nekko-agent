package com.nekko.protocol

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/** The computer's admitted mode for one persisted user turn, not evidence of tool calls or delegation. */
data class TurnStrategy(
    val tools: Tools,
    val orchestration: Orchestration,
    val reason: Reason? = null,
    val modelId: String? = null,
    val subagentModelId: String? = null,
    val subagentsDeferred: Boolean = false,
) {
    enum class Tools(val wire: String) { CODE("code"), LIST("list"), NONE("none"), CLAUDE_CODE("claude-code") }
    enum class Orchestration(val wire: String) { DIRECT("direct"), COORDINATOR("coordinator"), WORKER("worker"), EXTERNAL("external") }
    enum class Reason(val wire: String) { NOT_NEEDED("not-needed"), REQUESTED("requested"), SEPARABLE("separable"), UNAVAILABLE("unavailable"), OFF("off") }

    internal fun json(): JsonObject = buildJsonObject {
        put("tools", tools.wire)
        put("orchestration", orchestration.wire)
        reason?.let { put("reason", it.wire) }
        modelId?.let { put("modelId", it) }
        subagentModelId?.let { put("subagentModelId", it) }
        if (subagentsDeferred) put("subagentsDeferred", true)
    }

    companion object {
        fun from(e: JsonElement?): TurnStrategy? {
            val o = e.obj() ?: return null
            val tools = Tools.entries.firstOrNull { it.wire == o.str("tools") } ?: return null
            val orchestration = Orchestration.entries.firstOrNull { it.wire == o.str("orchestration") } ?: return null
            return TurnStrategy(
                tools, orchestration, Reason.entries.firstOrNull { it.wire == o.str("reason") },
                o.str("modelId")?.takeIf { it.isNotBlank() }, o.str("subagentModelId")?.takeIf { it.isNotBlank() },
                o["subagentsDeferred"] == kotlinx.serialization.json.JsonPrimitive(true),
            )
        }

        /** Only user prompts that have an admitted strategy. */
        fun sections(messages: List<ChatMessage>): Map<String, TurnStrategy> = buildMap {
            for (message in messages) {
                if (message.role != "user") continue
                val strategy = message.turnStrategy ?: continue
                put(message.id, strategy)
            }
        }
    }
}
