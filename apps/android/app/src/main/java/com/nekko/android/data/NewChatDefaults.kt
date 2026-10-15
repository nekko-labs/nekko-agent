package com.nekko.android.data

import com.nekko.protocol.AUTO_MODEL_ID

/**
 * The phone's own defaults for new chats (Settings → New chats), stored in
 * [PhonePrefs]. Nothing here changes the computer: the computer's default
 * model stays its own, and is what New chat falls back to.
 *
 * - **Default computer:** which paired computer the app connects to when it
 *   starts. Unset means "the one used last", as before.
 * - **Default model, per computer:** the model New chat opens with on that
 *   computer. Unset means "the computer's default", as before.
 */
class NewChatDefaults(private val prefs: PhonePrefs) {
    fun computerId(): String? = prefs.get(COMPUTER).ifEmpty { null }

    fun setComputer(id: String?) = if (id == null) prefs.reset(COMPUTER) else prefs.set(COMPUTER, id)

    /** The phone's pick for [computerId], or null when the computer's default applies. */
    fun model(computerId: String): ModelPick? = decode(prefs.get(MODELS))[computerId]

    fun setModel(computerId: String, pick: ModelPick?) {
        val next = decode(prefs.get(MODELS)).toMutableMap()
        if (pick == null) next.remove(computerId) else next[computerId] = pick
        if (next.isEmpty()) prefs.reset(MODELS) else prefs.set(MODELS, encode(next))
    }

    /** A computer was forgotten: drop everything the phone kept for it. */
    fun forget(computerId: String) {
        if (computerId() == computerId) setComputer(null)
        setModel(computerId, null)
    }

    /** For screens that redraw on change. */
    val computerFlow get() = prefs.flow(COMPUTER)
    val modelsFlow get() = prefs.flow(MODELS)

    companion object {
        val COMPUTER = PhonePrefs.string("newChat.computer", default = "")

        /**
         * `computerId\tproviderId\tmodelId` lines. Ids are generated (UUIDs) or
         * come from the computer's provider and model lists, and never contain a
         * tab or newline; a line that does not split into three is ignored.
         */
        val MODELS = PhonePrefs.string("newChat.models", default = "")

        internal fun decode(s: String): Map<String, ModelPick> = s.lineSequence().mapNotNull { line ->
            val parts = line.split('\t')
            if (parts.size != 3 || parts.any { it.isEmpty() } || parts[2] == AUTO_MODEL_ID) null
            else parts[0] to ModelPick(parts[1], parts[2])
        }.toMap()

        internal fun encode(m: Map<String, ModelPick>): String =
            m.entries.filter { (k, v) -> listOf(k, v.providerId, v.modelId).none { it.contains('\t') || it.contains('\n') } }
                .joinToString("\n") { (k, v) -> "$k\t${v.providerId}\t${v.modelId}" }

        /**
         * The computer to connect to at start: the phone's default when it is
         * still paired, else the one used last, else the first.
         */
        fun startComputer(preferred: String?, lastUsed: String?, paired: List<String>): String? = when {
            preferred != null && preferred in paired -> preferred
            lastUsed != null && lastUsed in paired -> lastUsed
            else -> paired.firstOrNull()
        }
    }
}
