package com.nekko.protocol

/**
 * New chat's "Nekko can do more with these" (#2950, the iPhone's `ConnectChecklist`, #2921): a
 * checklist over someone's first message, then a one-line note while nothing is connected. Each
 * row's [Row.done] names what got connected; the app fills them from the paired computers, the
 * active computer's folders and this phone's connectors.
 */
object ConnectChecklist {
    enum class Item { COMPUTER, FOLDER, GIT, TASKS }

    data class Row(
        val item: Item,
        /** What got connected ("MacBook Pro", "GitHub"); null while it isn't. */
        val done: String?,
        /** A folder lives on a computer, so its row waits for one. */
        val waiting: Boolean,
    ) {
        val isDone: Boolean get() = done != null
    }

    sealed interface Shown {
        data class Checklist(val rows: List<Row>) : Shown
        data object Note : Shown
        data object Nothing : Shown
    }

    fun rows(computer: String?, folder: String?, git: String?, tasks: String?): List<Row> = listOf(
        Row(Item.COMPUTER, computer, waiting = false),
        Row(Item.FOLDER, folder, waiting = computer == null && folder == null),
        Row(Item.GIT, git, waiting = false),
        Row(Item.TASKS, tasks, waiting = false),
    )

    /**
     * The checklist until the first message is sent and while a row is left; after it, the note
     * only when no computer, folder or git provider is connected. Closing hides both.
     */
    fun shown(computer: String?, folder: String?, git: String?, tasks: String?, sentBefore: Boolean, closed: Boolean): Shown {
        if (closed) return Shown.Nothing
        val all = rows(computer, folder, git, tasks)
        if (!sentBefore) return if (all.all { it.isDone }) Shown.Nothing else Shown.Checklist(all)
        return if (computer == null && folder == null && git == null) Shown.Note else Shown.Nothing
    }

    /**
     * Whether someone has sent a message before: a chat anywhere with an exchange. A chat whose
     * count is unknown (an older computer) counts as used, as the first-prompt intro does.
     */
    fun sentBefore(remembered: Boolean, exchangeCounts: List<Long?>): Boolean =
        remembered || exchangeCounts.any { it != 0L }
}
