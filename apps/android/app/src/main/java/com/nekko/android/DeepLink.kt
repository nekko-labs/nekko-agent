package com.nekko.android

/** What an incoming URI asks the app to do. */
sealed interface DeepLink {
    data object Talk : DeepLink
    data object Dashboard : DeepLink
    /** A pairing link: open the pair screen pre-filled and ask before pairing. */
    data class Pair(val raw: String) : DeepLink

    /**
     * `nekko-agent://chat/<id>`: open one of the active computer's chats.
     * `?alwaysAllow=<call id>` (the approval notification's **Always allow this
     * tool**) asks that chat's approval card to run its own Always allow for that call.
     */
    data class Chat(val id: String, val alwaysAllow: String? = null) : DeepLink

    /** Text shared from another app (the text itself waits in ShareInbox): open New chat. */
    data object Share : DeepLink

    /** `nekko-agent://new`: open New chat (the launcher's "New chat" shortcut). */
    data object NewChat : DeepLink

    companion object {
        /** Pure so it can be unit-tested; MainActivity feeds it the parts of an android.net.Uri. */
        fun from(raw: String, scheme: String?, host: String?, path: List<String>, alwaysAllow: String? = null): DeepLink? {
            val s = scheme?.lowercase() ?: return null
            return when {
                s == "nekko-agent-pair" -> Pair(raw)
                s == "nekko-agent" && raw.contains("relay=") -> Pair(raw)
                s == "nekko-agent" && host == "chat" && path.isNotEmpty() -> Chat(path.first(), alwaysAllow?.takeIf { it.isNotEmpty() })
                s == "nekko-agent" && host == "new" -> NewChat
                else -> null
            }
        }
    }
}
