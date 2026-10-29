package com.nekko.android.data

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/**
 * Simple and Expert: the controls each mode shows. Every listed control shows in both modes,
 * in Expert only, or nowhere, chosen per phone in Settings > Simple mode. The phone's subset of
 * the desktop's list (packages/shared/src/simple-mode.ts); keep the ids in step.
 */
enum class SimpleVisibility(val wire: String) {
    SHOW("show"), EXPERT("expert"), HIDE("hide");

    companion object {
        fun of(wire: String): SimpleVisibility? = entries.firstOrNull { it.wire == wire }
    }
}

data class SimpleItem(val id: String, val area: String, val label: String, val hint: String, val default: SimpleVisibility)

object SimpleMode {
    private val E = SimpleVisibility.EXPERT

    val ITEMS: List<SimpleItem> = listOf(
        SimpleItem("changes", "Chat · header", "Changes", "Review the files the agent changed", E),
        SimpleItem("hardware", "Chat · header", "Hardware strip", "CPU, memory and GPU dials under the title", E),
        SimpleItem("ph-subtitle", "Chat · header", "Model and computer under the title", "Like \"Opus 5.5 · Studio Mac\"", E),
        SimpleItem("model", "Chat · message box", "Model name and picker", "Switch between Claude, ChatGPT or a local model", SimpleVisibility.SHOW),
        SimpleItem("effort", "Chat · message box", "Effort", "How hard the model thinks before it answers", SimpleVisibility.SHOW),
        SimpleItem("context", "Chat · message box", "Context ring and token count", "How full this chat is, in tokens", SimpleVisibility.SHOW),
        SimpleItem("ph-policy", "Chat · message box", "Tool policy", "Ask, Guardrails or YOLO, in the More menu and New chat", E),
        SimpleItem("thinking", "Chat · conversation", "Reasoning and tool steps", "What the model thought, and each step it took", E),
        SimpleItem("ph-git", "Chat · conversation", "Git and pull requests", "Commits, PR cards and the PR dock", E),
        SimpleItem("terminal", "Agents wall", "Terminal", "Open a terminal from New or the More menu", E),
        SimpleItem("ph-monitors", "Phone · chats list", "Monitors row", "Hardware and loaded models at the top of Chats", E),
    )

    private val BY_ID = ITEMS.associateBy { it.id }

    /** The items grouped by area, in catalogue order. */
    val AREAS: List<Pair<String, List<SimpleItem>>> = ITEMS.groupBy { it.area }.toList()

    /** The person's choices, as JSON holding only values that differ from the defaults. */
    val CHOICES = PhonePrefs.string("simpleChoices", default = "")

    /** Where an item shows, after the person's choice. Unknown ids always show. */
    fun visibility(id: String, choices: Map<String, SimpleVisibility>): SimpleVisibility {
        val item = BY_ID[id] ?: return SimpleVisibility.SHOW
        return choices[id] ?: item.default
    }

    /** Items set to Expert only that Simple also shows while the computer's Model Server holds a model. */
    val LOCAL_MODEL_IDS = setOf("hardware", "ph-monitors")

    /** What Settings says under those items. */
    const val LOCAL_MODEL_NOTE = "Also shown in Simple while a local model is loaded"

    /** Whether an item is on screen in the given mode. */
    fun shown(id: String, expert: Boolean, choices: Map<String, SimpleVisibility>, localModelLoaded: Boolean = false): Boolean {
        val v = visibility(id, choices)
        return v == SimpleVisibility.SHOW || (v == SimpleVisibility.EXPERT && (expert || (localModelLoaded && id in LOCAL_MODEL_IDS)))
    }

    /** Simple's "chat getting long" line shows from this share of the context window. */
    const val LONG_CHAT_FRACTION = 0.85

    /**
     * What starting fresh would save: the conversation's tokens, once [used] reaches
     * [LONG_CHAT_FRACTION] of [window]; null below it, without a window, or without the breakdown.
     */
    fun freshSavings(used: Long, window: Long?, sources: List<Pair<String, Long>>): Long? {
        if (window == null || window <= 0 || used < window * LONG_CHAT_FRACTION) return null
        return sources.firstOrNull { it.first == "conversation" }?.second?.takeIf { it > 0 }
    }

    /** Saved choices, keeping only known ids with valid values that differ from the default. Never throws. */
    fun parse(raw: String?): Map<String, SimpleVisibility> {
        val obj = raw?.takeIf { it.isNotBlank() }?.let { runCatching { Json.parseToJsonElement(it) }.getOrNull() } as? JsonObject
            ?: return emptyMap()
        return obj.mapNotNull { (id, v) ->
            val item = BY_ID[id] ?: return@mapNotNull null
            val value = (v as? JsonPrimitive)?.takeIf { it.isString }?.content?.let(SimpleVisibility::of)
            if (value == null || value == item.default) null else id to value
        }.toMap()
    }

    fun encode(choices: Map<String, SimpleVisibility>): String = buildJsonObject {
        choices.forEach { (id, v) -> if (BY_ID[id]?.default?.let { it != v } == true) put(id, v.wire) }
    }.toString()

    /** [choices] with [id] set to [value]; the default is stored as no entry. */
    fun with(choices: Map<String, SimpleVisibility>, id: String, value: SimpleVisibility): Map<String, SimpleVisibility> =
        if (BY_ID[id]?.default == value) choices - id else choices + (id to value)
}
