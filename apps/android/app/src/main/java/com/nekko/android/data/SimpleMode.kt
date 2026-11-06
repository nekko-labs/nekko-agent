package com.nekko.android.data

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/**
 * Simple and Expert: the controls each mode shows, and only while they mean something. Every listed
 * control has one visibility, chosen per phone in Settings > Simple mode. The phone's subset of the
 * desktop's list (packages/shared/src/simple-mode.ts); keep the ids and the rules in step.
 */
enum class SimpleVisibility(val wire: String) {
    SHOW("show"), EXPERT("expert"), HIDE("hide"),

    /** In both modes, but only while its condition holds. */
    AUTO("auto");

    companion object {
        fun of(wire: String): SimpleVisibility? = entries.firstOrNull { it.wire == wire }
    }
}

/** What can make a control relevant. */
enum class SimpleCondition { LOCAL_MODEL, CHANGES, PR }

/** What is true right now. [localModel]: a local model runs on the computer this phone is connected to. */
data class SimpleContext(val localModel: Boolean = false, val changes: Boolean = false, val pr: Boolean = false) {
    fun holds(c: SimpleCondition) = when (c) {
        SimpleCondition.LOCAL_MODEL -> localModel
        SimpleCondition.CHANGES -> changes
        SimpleCondition.PR -> pr
    }
}

/** [needs]: it has nothing to show without this, in any mode. [whenever]: what an AUTO control waits for. */
data class SimpleItem(
    val id: String,
    val area: String,
    val default: SimpleVisibility,
    val needs: SimpleCondition? = null,
    val whenever: SimpleCondition? = null,
)

object SimpleMode {
    private val E = SimpleVisibility.EXPERT
    private val S = SimpleVisibility.SHOW
    private val A = SimpleVisibility.AUTO

    const val HEADER = "Chat · header"
    const val BOX = "Chat · message box"
    const val CONVERSATION = "Chat · conversation"
    const val CHATS = "Phone · chats list"

    val ITEMS: List<SimpleItem> = listOf(
        SimpleItem("changes", HEADER, S, needs = SimpleCondition.CHANGES),
        SimpleItem("hardware", HEADER, A, whenever = SimpleCondition.LOCAL_MODEL),
        SimpleItem("ph-subtitle", HEADER, E),
        SimpleItem("model", BOX, S),
        SimpleItem("effort", BOX, S),
        SimpleItem("asks", BOX, S),
        SimpleItem("context", BOX, S),
        SimpleItem("run-settings", BOX, E),
        SimpleItem("thinking", CONVERSATION, E),
        SimpleItem("pr-status", CONVERSATION, S, needs = SimpleCondition.PR),
        SimpleItem("ph-git", CONVERSATION, E),
        SimpleItem("ph-monitors", CHATS, A, whenever = SimpleCondition.LOCAL_MODEL),
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

    /** The choices an item offers. Show pins an AUTO control on, so it takes the place of Expert only. */
    fun options(item: SimpleItem): List<SimpleVisibility> =
        if (item.default == A) listOf(A, S, SimpleVisibility.HIDE) else listOf(S, E, SimpleVisibility.HIDE)

    /**
     * Whether an item is on screen now, as `simpleShown` decides on the desktop. Hide always wins,
     * [SimpleItem.needs] is required in every mode, AUTO waits for its condition, and Expert only
     * stays for Expert.
     */
    fun shown(id: String, expert: Boolean, choices: Map<String, SimpleVisibility>, context: SimpleContext = SimpleContext()): Boolean {
        val item = BY_ID[id]
        val v = visibility(id, choices)
        if (v == SimpleVisibility.HIDE || item?.needs?.let(context::holds) == false) return false
        if (v == A) return item?.whenever?.let(context::holds) == true
        return v == S || expert
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
            if (value == null || value !in options(item) || value == item.default) null else id to value
        }.toMap()
    }

    fun encode(choices: Map<String, SimpleVisibility>): String = buildJsonObject {
        choices.forEach { (id, v) -> if (BY_ID[id]?.default?.let { it != v } == true) put(id, v.wire) }
    }.toString()

    /** [choices] with [id] set to [value]; the default is stored as no entry. */
    fun with(choices: Map<String, SimpleVisibility>, id: String, value: SimpleVisibility): Map<String, SimpleVisibility> =
        if (BY_ID[id]?.default == value) choices - id else choices + (id to value)
}
