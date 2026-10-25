package com.nekko.protocol

/**
 * The two panes of an open folding phone (spec/phone/folding-phones-two-chats-and-monitors.md,
 * *Panes* and *Vertical mode*): what each pane holds, which one has the keyboard, the
 * divider, and the rules for Swap, Focus, Replace with…, opening a chat and rotating.
 * Pure JVM, like [Posture], so every rule is unit-tested without an Android runtime;
 * the app's `PanesHost` only draws what this decides.
 */
sealed interface PaneContent {
    /** The chat list. */
    data object Chats : PaneContent

    /** The phone edition of the desktop's Agent Monitor dock ([MonitorSummary]). */
    data object Monitors : PaneContent

    /** One chat on the computer; [id] null is a chat pane with nothing picked yet. */
    data class Chat(val id: String?) : PaneContent

    /** Identifies the pane's view across moves (rotation, Swap), so its state moves with it. */
    val key: String
        get() = when (this) {
            Chats -> "chats"
            Monitors -> "monitors"
            is Chat -> if (id == null) "chat" else "chat:$id"
        }

    companion object {
        /** The stored form ([key]); null for anything this version doesn't know. */
        fun parse(s: String): PaneContent? = when {
            s == "chats" -> Chats
            s == "monitors" -> Monitors
            s == "chat" -> Chat(null)
            s.startsWith("chat:") && s.length > 5 -> Chat(s.substring(5))
            else -> null
        }
    }
}

/** Left or top ([FIRST], the primary), right or bottom ([SECOND]). */
enum class PaneSide {
    FIRST,
    SECOND,
    ;

    val other: PaneSide get() = if (this == FIRST) SECOND else FIRST
}

/** The four arrangements the owner picks from (either way round). */
enum class PaneArrangement(val label: String) {
    CHAT_CHAT("Chat + Chat"),
    CHAT_MONITORS("Chat + Monitors"),
    CHATS_CHAT("Chats + Chat"),
    MONITORS_CHATS("Monitors + Chats"),
    ;

    companion object {
        /** The arrangement two panes make, in either order; null for two lists or two Monitors. */
        fun of(a: PaneContent, b: PaneContent): PaneArrangement? {
            val kinds = setOf(a::class, b::class)
            return when {
                a is PaneContent.Chat && b is PaneContent.Chat -> CHAT_CHAT
                kinds == setOf(PaneContent.Chat::class, PaneContent.Monitors::class) -> CHAT_MONITORS
                kinds == setOf(PaneContent.Chat::class, PaneContent.Chats::class) -> CHATS_CHAT
                kinds == setOf(PaneContent.Monitors::class, PaneContent.Chats::class) -> MONITORS_CHATS
                else -> null
            }
        }
    }
}

/** How the window is split for a posture. */
enum class PaneMode {
    /** Closed: today's one-column app. */
    ONE,

    /** Open wide or book: two panes side by side. */
    SIDE_BY_SIDE,

    /** Open tall ("vertical mode"): two panes stacked, the primary on top. */
    STACKED,

    /** Half open, hinge horizontal: the focused pane in flex layout, the other an edge tab. */
    TABLETOP,
    ;

    val twoPanes: Boolean get() = this == SIDE_BY_SIDE || this == STACKED

    companion object {
        /**
         * The split for [posture]. A separating hinge (Surface Duo's two screens) always
         * divides the panes, so a tall Duo with its gap running down the middle is side by
         * side and a wide one with the gap across is stacked: nothing straddles the gap.
         */
        fun of(posture: Posture, hinge: Hinge?): PaneMode {
            val separating = hinge?.isSeparating == true
            return when (posture) {
                Posture.CLOSED -> ONE
                Posture.TABLETOP -> TABLETOP
                Posture.OPEN_WIDE, Posture.BOOK ->
                    if (separating && hinge?.orientation == Hinge.Orientation.HORIZONTAL) STACKED else SIDE_BY_SIDE
                Posture.OPEN_TALL ->
                    if (separating && hinge?.orientation == Hinge.Orientation.VERTICAL) SIDE_BY_SIDE else STACKED
            }
        }
    }
}

/**
 * Where the divider falls, in dp along the split axis (x side by side, y stacked or
 * tabletop): the first pane is [first] long, then a [gap], then the second pane.
 * [onHinge] means the divider is the hinge and can't be dragged.
 */
data class PaneSplit(val first: Float, val gap: Float, val onHinge: Boolean) {
    /** Where the second pane starts. */
    val secondStart: Float get() = first + gap

    companion object {
        /** The draggable divider's thickness on a screen without a hinge. */
        const val DIVIDER_DP = 12f

        /**
         * The split for [mode] in a [widthDp] × [heightDp] window. A hinge running along
         * the split (vertical side by side; horizontal stacked or tabletop) is the divider,
         * its bounds the gap (zero wide on a Fold, the gap between Surface Duo's screens).
         * Anything else splits at [fraction], held between 35 / 65 and 65 / 35.
         */
        fun of(mode: PaneMode, widthDp: Float, heightDp: Float, hinge: Hinge?, fraction: Float): PaneSplit {
            val across = mode == PaneMode.SIDE_BY_SIDE
            val total = if (across) widthDp else heightDp
            if (hinge != null) {
                val along = if (across) hinge.orientation == Hinge.Orientation.VERTICAL else hinge.orientation == Hinge.Orientation.HORIZONTAL
                val start = if (across) hinge.bounds.x else hinge.bounds.y
                val size = if (across) hinge.bounds.width else hinge.bounds.height
                if (along && start > 0f && start + size < total) return PaneSplit(start, size, onHinge = true)
            }
            val f = PaneLayout.clampSplit(fraction)
            return PaneSplit((total - DIVIDER_DP) * f, DIVIDER_DP, onHinge = false)
        }
    }
}

/**
 * What the two panes hold. [first] is left or top, [second] right or bottom;
 * [focused] has the keyboard (and is the primary after a rotation); [zoomed]
 * is the pane Focus made fill the screen, the other an edge tab; [split] is
 * the first pane's share on a screen without a hinge.
 */
data class PaneLayout(
    val first: PaneContent = PaneContent.Chats,
    val second: PaneContent = PaneContent.Chat(null),
    val focused: PaneSide = PaneSide.SECOND,
    val zoomed: PaneSide? = null,
    val split: Float = 0.5f,
) {
    operator fun get(side: PaneSide): PaneContent = if (side == PaneSide.FIRST) first else second

    val arrangement: PaneArrangement? get() = PaneArrangement.of(first, second)

    /** The chats on screen, first pane first. */
    val chatIds: List<String> get() = listOf(first, second).mapNotNull { (it as? PaneContent.Chat)?.id }

    /** The side showing [chatId], if either does. */
    fun sideOf(chatId: String): PaneSide? = when (chatId) {
        (first as? PaneContent.Chat)?.id -> PaneSide.FIRST
        (second as? PaneContent.Chat)?.id -> PaneSide.SECOND
        else -> null
    }

    private fun with(side: PaneSide, content: PaneContent) =
        if (side == PaneSide.FIRST) copy(first = content) else copy(second = content)

    /** **Swap**: the two panes trade places; focus and Focus go with their pane. */
    fun swap(): PaneLayout = copy(first = second, second = first, focused = focused.other, zoomed = zoomed?.other, split = 1f - split)

    fun focus(side: PaneSide): PaneLayout = if (focused == side) this else copy(focused = side)

    /** **Focus**: [side] fills the screen (null brings both back). Focusing it gives it the keyboard too. */
    fun zoom(side: PaneSide?): PaneLayout = copy(zoomed = side, focused = side ?: focused)

    /** The divider dragged to [fraction] of the way across (held to 35–65). */
    fun withSplit(fraction: Float): PaneLayout = copy(split = clampSplit(fraction))

    /**
     * **Replace with…**: [side] shows [content] and takes the focus. A chat already open
     * in the other pane trades places instead, so one chat is never in both panes.
     */
    fun replace(side: PaneSide, content: PaneContent): PaneLayout {
        if (content == this[side]) return focus(side)
        val id = (content as? PaneContent.Chat)?.id
        if (id != null && sideOf(id) == side.other) return swap().focus(side)
        return with(side, content).focus(side)
    }

    /**
     * A chat tapped in a pane (a row of the Chats list, a running chat in Monitors):
     * it opens in the other pane, so the list or Monitors stays beside it, unless the
     * other pane is Monitors and the tap came from the list (*Monitors + Chats*), when
     * the list's own pane becomes the chat. A chat already on screen just takes the focus.
     * [from] null (a link, the chat the closed phone showed when it opens) fills an empty
     * chat pane, else the focused chat pane, else the other chat pane, else the second.
     */
    fun open(chatId: String, from: PaneSide? = null): PaneLayout {
        sideOf(chatId)?.let { side -> return focus(side).copy(zoomed = zoomed?.let { side }) }
        val sides = listOf(PaneSide.SECOND, PaneSide.FIRST)
        val target = when {
            from != null && this[from.other] == PaneContent.Monitors && this[from] == PaneContent.Chats -> from
            from != null -> from.other
            else -> sides.firstOrNull { this[it] == PaneContent.Chat(null) }
                ?: focused.takeIf { this[it] is PaneContent.Chat }
                ?: sides.firstOrNull { this[it] is PaneContent.Chat }
                ?: PaneSide.SECOND
        }
        return with(target, PaneContent.Chat(chatId)).focus(target).copy(zoomed = zoomed?.let { target })
    }

    /** A chat's pane's Back: that pane goes back to the chat list. */
    fun back(side: PaneSide): PaneLayout = replace(side, PaneContent.Chats)

    /** A chat deleted or completed out from under a pane: the pane waits for another. */
    fun forget(chatId: String): PaneLayout {
        var l = this
        if ((first as? PaneContent.Chat)?.id == chatId) l = l.copy(first = PaneContent.Chat(null))
        if ((second as? PaneContent.Chat)?.id == chatId) l = l.copy(second = PaneContent.Chat(null))
        return l
    }

    /**
     * The layout as [mode] shows it after a posture change from [from]. Rotating keeps
     * both panes and makes the focused one the primary (left or top). Stacked, the chat
     * list is never the bottom pane (a list under a chat reads as its attachments):
     * *Chats + Chat* becomes *Chat over Monitors*, the list one Back away in the top pane,
     * and *Monitors + Chats* becomes *Chats over Monitors*.
     */
    fun forMode(mode: PaneMode, from: PaneMode?): PaneLayout {
        var l = this
        val changed = from != null && from != mode && mode.twoPanes && from.twoPanes
        if (changed && l.focused == PaneSide.SECOND) l = l.swap()
        l = l.normalized(mode)
        if (mode == PaneMode.TABLETOP && l.zoomed == null) l = l.copy(zoomed = l.focused)
        if (from == PaneMode.TABLETOP && mode != PaneMode.TABLETOP && l.zoomed != null) l = l.copy(zoomed = null)
        return l
    }

    /**
     * The stacked rule alone: the list is never the bottom pane, and a list above a
     * chat becomes that chat above Monitors (the list one Back away).
     */
    fun stacked(): PaneLayout {
        val chatBelow = (second as? PaneContent.Chat)?.id != null
        return when {
            // Chats + Chat → Chat over Monitors; the chat keeps the focus.
            first == PaneContent.Chats && chatBelow ->
                copy(first = second, second = PaneContent.Monitors, focused = PaneSide.FIRST, zoomed = zoomed?.let { PaneSide.FIRST })
            second != PaneContent.Chats -> this
            // Monitors + Chats → Chats over Monitors.
            first == PaneContent.Monitors -> swap()
            // A chat (or a list) over the list → over Monitors; the top pane keeps the focus.
            else -> copy(second = PaneContent.Monitors, focused = PaneSide.FIRST, zoomed = zoomed?.let { PaneSide.FIRST })
        }
    }

    /** [mode]'s standing rules applied after any change (only stacked has one). */
    fun normalized(mode: PaneMode): PaneLayout = if (mode == PaneMode.STACKED) stacked() else this

    /**
     * The one-time tip: in *Chats + Chat*, opening a second chat while the first is still
     * [running] offers *Chat + Chat*. Returns the chat to keep beside the new one, or null.
     */
    fun tipFor(next: PaneLayout, running: Set<String>): String? {
        if (arrangement != PaneArrangement.CHATS_CHAT || next.arrangement != PaneArrangement.CHATS_CHAT) return null
        val before = chatIds.singleOrNull() ?: return null
        val after = next.chatIds.singleOrNull() ?: return null
        return before.takeIf { it != after && it in running }
    }

    /** The tip taken: the list's pane shows [keep], beside the chat just opened. */
    fun chatBeside(keep: String): PaneLayout {
        val listSide = if (first == PaneContent.Chats) PaneSide.FIRST else if (second == PaneContent.Chats) PaneSide.SECOND else return this
        return with(listSide, PaneContent.Chat(keep))
    }

    /** One line of the per-computer store; [zoomed] is not kept. */
    fun encode(): String = listOf(safe(first).key, safe(second).key, split.toString(), focused.name).joinToString("\t")

    companion object {
        const val MIN_SPLIT = 0.35f
        const val MAX_SPLIT = 0.65f

        /** The first open: *Chats + Chat*, the chat list beside one chat (today's iPad layout). */
        val DEFAULT = PaneLayout()

        fun clampSplit(f: Float): Float = if (f.isNaN()) 0.5f else f.coerceIn(MIN_SPLIT, MAX_SPLIT)

        /** A chat id that can't be stored on one tab-separated line is dropped, never mangled. */
        private fun safe(c: PaneContent): PaneContent =
            if (c is PaneContent.Chat && c.id != null && (c.id.contains('\t') || c.id.contains('\n'))) PaneContent.Chat(null) else c

        /** [encode]'s line back; null when it isn't one (an older or newer format). */
        fun decode(s: String): PaneLayout? {
            val parts = s.split('\t')
            if (parts.size < 2) return null
            val first = PaneContent.parse(parts[0]) ?: return null
            val second = PaneContent.parse(parts[1]) ?: return null
            val split = parts.getOrNull(2)?.toFloatOrNull()?.let(::clampSplit) ?: 0.5f
            val focused = parts.getOrNull(3)?.let { n -> PaneSide.entries.firstOrNull { it.name == n } } ?: PaneSide.SECOND
            return PaneLayout(first, second, focused, null, split)
        }

        /** `computerId\t<layout>` lines: the arrangement is remembered per computer, on the phone only. */
        fun decodeAll(s: String): Map<String, PaneLayout> = s.lineSequence().mapNotNull { line ->
            val tab = line.indexOf('\t')
            if (tab <= 0) null else decode(line.substring(tab + 1))?.let { line.substring(0, tab) to it }
        }.toMap()

        fun encodeAll(m: Map<String, PaneLayout>): String =
            m.entries.filter { (id, _) -> id.isNotEmpty() && !id.contains('\t') && !id.contains('\n') }
                .joinToString("\n") { (id, l) -> "$id\t${l.encode()}" }
    }
}
