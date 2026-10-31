package com.nekko.protocol

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.text.Collator
import java.time.Instant
import java.time.ZoneId
import java.util.Locale

/**
 * How the phone's chat list arranges its chats: what it groups them by, the
 * order inside each group, and what it shows. The desktop Agents panel's view
 * menu (apps/desktop/src/renderer/views/agentPanelView.ts), as on the iPhone
 * (`ChatListLayout.swift`), kept as a phone preference rather than a computer
 * setting.
 *
 * The defaults are the list as it was: by project, in the desktop's dragged
 * order (newest first for the rest), with previews, completed chats and every
 * project folder shown.
 */
data class ChatListView(
    val groupBy: GroupBy = GroupBy.PROJECT,
    val sortBy: SortBy = SortBy.MANUAL,
    /** Manual order has no direction: it is whatever was dragged on the computer. */
    val ascending: Boolean = false,
    /** The last reply (or first prompt) under each title. */
    val showPreviews: Boolean = true,
    /** Completed chats, after their group's active ones (in a Completed group when not by project). */
    val showCompleted: Boolean = true,
    /** Project folders with no chats in them. */
    val showEmptyGroups: Boolean = true,
) {
    enum class GroupBy(val wire: String) { PROJECT("project"), STATUS("status"), DATE("date"), NONE("none") }

    /** No "Date created" as on the desktop: the phone's summaries carry only the last update. */
    enum class SortBy(val wire: String) { MANUAL("manual"), UPDATED("updated"), NAME("name") }

    val isStandard: Boolean get() = this == STANDARD

    /** Groups keep a dragged order only when they are the project folders; the status and date groups have a fixed order. */
    val canReorderGroups: Boolean get() = groupBy == GroupBy.PROJECT

    /** Pick a sort. Names start A to Z and dates newest first, as on the desktop. */
    fun withSort(s: SortBy): ChatListView = if (s == sortBy) this else copy(sortBy = s, ascending = s == SortBy.NAME)

    /** The iPhone's encoding (the same keys), so a saved view reads the same on both. */
    fun encoded(): String = buildJsonObject {
        put("groupBy", groupBy.wire)
        put("sortBy", sortBy.wire)
        put("ascending", ascending)
        put("showPreviews", showPreviews)
        put("showCompleted", showCompleted)
        put("showEmptyGroups", showEmptyGroups)
    }.toString()

    companion object {
        val STANDARD = ChatListView()

        /** A saved view keeps every field that is still valid; the rest fall back to the defaults. */
        fun parse(raw: String?): ChatListView {
            val o = runCatching { Json.parseToJsonElement(raw ?: return STANDARD) }.getOrNull().obj() ?: return STANDARD
            fun flag(k: String, d: Boolean) = (o[k] as? JsonPrimitive)?.takeIf { !it.isString }?.content?.toBooleanStrictOrNull() ?: d
            return ChatListView(
                groupBy = GroupBy.entries.firstOrNull { it.wire == o.str("groupBy") } ?: STANDARD.groupBy,
                sortBy = SortBy.entries.firstOrNull { it.wire == o.str("sortBy") } ?: STANDARD.sortBy,
                ascending = flag("ascending", STANDARD.ascending),
                showPreviews = flag("showPreviews", STANDARD.showPreviews),
                showCompleted = flag("showCompleted", STANDARD.showCompleted),
                showEmptyGroups = flag("showEmptyGroups", STANDARD.showEmptyGroups),
            )
        }
    }
}

/** One group of the chat list as the view arranges it. */
data class ChatSection(
    val key: String,
    val name: String,
    /** Active chats in the view's order, then completed ones (most recently completed first). */
    val chats: List<SessionSummary>,
    val activeCount: Int,
    val doneCount: Int,
) {
    companion object {
        const val COMPLETED = "__completed"
    }
}

object ChatSections {
    /** A group shows at most this many chats before "Show more"... */
    const val SHOWN_LIMIT = 8

    /** ...and only those touched in this window (ms). */
    const val RECENT_WINDOW: Long = 14L * 24 * 60 * 60 * 1000

    /** The status groups, most urgent first. */
    val STATUS_GROUPS = listOf("status:input" to "Needs you", "status:working" to "Working", "status:idle" to "Idle")

    /** The date groups, newest first, counted in local calendar days. */
    val DATE_GROUPS = listOf(
        "date:today" to "Today", "date:yesterday" to "Yesterday", "date:week" to "Previous 7 days",
        "date:month" to "Previous 30 days", "date:older" to "Older",
    )

    /**
     * The list's groups for [view]. Project groups follow [groupOrder] (folder
     * ids and [ChatGroup.GENERAL], as arranged on the phone); folders it doesn't
     * name keep the computer's order after the ones it does.
     */
    fun make(
        chats: List<SessionSummary>,
        folders: List<WorkspaceFolder>,
        view: ChatListView,
        activity: Map<String, Activity>,
        groupOrder: List<String> = emptyList(),
        now: Long,
        zone: ZoneId = ZoneId.systemDefault(),
    ): List<ChatSection> {
        val sort = comparator(view)
        fun done(list: List<SessionSummary>) =
            if (view.showCompleted) list.filter { it.archived }.sortedByDescending { it.archivedAt ?: 0L } else emptyList()
        fun section(key: String, name: String, active: List<SessionSummary>, completed: List<SessionSummary>) =
            ChatSection(key, name, active + completed, active.size, completed.size)

        if (view.groupBy == ChatListView.GroupBy.PROJECT) {
            val groups = ChatGroup.of(chats, folders).mapNotNull { g ->
                val active = if (view.sortBy == ChatListView.SortBy.MANUAL) g.active else g.active.sortedWith(sort)
                val s = section(g.key, g.name, active, done(g.completed))
                // General is listed only when it has chats; a folder unless empty ones are hidden.
                if (s.chats.isEmpty() && (g.key == ChatGroup.GENERAL || !view.showEmptyGroups)) null else s
            }
            return ChatGroupOrder.apply(groups.map { it.key }, groupOrder).mapNotNull { k -> groups.firstOrNull { it.key == k } }
        }

        val active = chats.filter { !it.archived }.sortedWith(sort)
        val completedAll = done(chats)
        val completed = if (completedAll.isEmpty()) emptyList() else listOf(section(ChatSection.COMPLETED, "Completed", emptyList(), completedAll))
        if (view.groupBy == ChatListView.GroupBy.NONE) {
            return (if (active.isEmpty()) emptyList() else listOf(section("all", "All chats", active, emptyList()))) + completed
        }
        val defs = if (view.groupBy == ChatListView.GroupBy.STATUS) STATUS_GROUPS else DATE_GROUPS
        val grouped = active.groupBy { s ->
            if (view.groupBy == ChatListView.GroupBy.STATUS) statusKey(activity[s.id]) else dateKey(s.updatedAt, now, zone)
        }
        return defs.mapNotNull { (key, name) ->
            val items = grouped[key].orEmpty()
            if (items.isEmpty() && !view.showEmptyGroups) null else section(key, name, items, emptyList())
        } + completed
    }

    /**
     * The chats a group shows before "Show more", and how many that leaves out:
     * up to [SHOWN_LIMIT] touched within [RECENT_WINDOW], in order. A chat that
     * is working, needs you or is pinned is always shown.
     */
    fun split(s: ChatSection, activity: Map<String, Activity>, now: Long): Pair<List<SessionSummary>, Int> {
        val since = now - RECENT_WINDOW
        val shown = ArrayList<SessionSummary>()
        var hidden = 0
        for (c in s.chats) {
            val always = activity[c.id] != null || c.pinned
            val recent = maxOf(c.updatedAt, c.archivedAt ?: 0L) >= since
            if (always || (recent && shown.size < SHOWN_LIMIT)) shown += c else hidden++
        }
        return shown to hidden
    }

    fun statusKey(a: Activity?): String = when (a) {
        Activity.NEEDS_YOU -> "status:input"
        Activity.RUNNING -> "status:working"
        null -> "status:idle"
    }

    fun dateKey(at: Long, now: Long, zone: ZoneId = ZoneId.systemDefault()): String {
        val today = Instant.ofEpochMilli(now).atZone(zone).toLocalDate()
        fun start(daysBack: Long) = today.minusDays(daysBack).atStartOfDay(zone).toInstant().toEpochMilli()
        return when {
            at >= start(0) -> "date:today"
            at >= start(1) -> "date:yesterday"
            at >= start(7) -> "date:week"
            at >= start(30) -> "date:month"
            else -> "date:older"
        }
    }

    /** Active chats in the view's order. Manual: dragged ones first, then most recent. */
    fun comparator(view: ChatListView): Comparator<SessionSummary> = when (view.sortBy) {
        ChatListView.SortBy.MANUAL -> compareBy<SessionSummary> { it.order == null }.thenBy { it.order ?: 0.0 }.thenByDescending { it.updatedAt }
        ChatListView.SortBy.UPDATED -> if (view.ascending) compareBy { it.updatedAt } else compareByDescending { it.updatedAt }
        ChatListView.SortBy.NAME -> {
            val byName = Comparator<SessionSummary> { a, b -> naturalCompare(a.title, b.title) }
            (if (view.ascending) byName else byName.reversed()).thenByDescending { it.updatedAt }
        }
    }

    private val collator: Collator = Collator.getInstance(Locale.ROOT).apply { strength = Collator.PRIMARY }
    private val RUNS = Regex("""\d+|\D+""")

    /** Finder-like order (`localizedStandardCompare`): case and accents ignored, "gamma 9" before "gamma 10". */
    internal fun naturalCompare(a: String, b: String): Int {
        val x = RUNS.findAll(a).map { it.value }.toList()
        val y = RUNS.findAll(b).map { it.value }.toList()
        for (i in 0 until minOf(x.size, y.size)) {
            val p = x[i]
            val q = y[i]
            val c = if (p[0].isDigit() && q[0].isDigit()) {
                p.trimStart('0').length.compareTo(q.trimStart('0').length).takeIf { it != 0 } ?: p.trimStart('0').compareTo(q.trimStart('0'))
            } else {
                collator.compare(p, q)
            }
            if (c != 0) return c
        }
        return x.size.compareTo(y.size)
    }
}

/** The project groups' order as arranged on the phone. */
object ChatGroupOrder {
    /** [keys] in the [saved] order; keys the saved order doesn't name follow, in their own order. */
    fun apply(keys: List<String>, saved: List<String>): List<String> {
        val present = keys.toSet()
        val known = saved.filter { it in present }.distinct()
        return known + keys.filter { it !in known }
    }

    /** Move [key] to just before [target] (to the end when null). Unchanged when either is unknown. */
    fun move(keys: List<String>, key: String, before: String?): List<String> {
        if (key !in keys || key == before) return keys
        val out = keys.filter { it != key }.toMutableList()
        if (before == null) {
            out += key
        } else {
            val i = out.indexOf(before).takeIf { it >= 0 } ?: return keys
            out.add(i, key)
        }
        return out
    }
}
