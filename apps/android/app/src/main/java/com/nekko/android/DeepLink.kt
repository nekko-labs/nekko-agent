package com.nekko.android

/** What an incoming URI asks the app to do. */
sealed interface DeepLink {
    /** A pairing link: open the pair screen pre-filled and ask before pairing. */
    data class Pair(val raw: String) : DeepLink

    /** `nekko-agent://chat/<id>`: open one of the active computer's chats. */
    data class Chat(val id: String) : DeepLink

    companion object {
        /** Pure so it can be unit-tested; MainActivity feeds it the parts of an android.net.Uri. */
        fun from(raw: String, scheme: String?, host: String?, path: List<String>): DeepLink? {
            val s = scheme?.lowercase() ?: return null
            return when {
                s == "nekko-agent-pair" -> Pair(raw)
                s == "nekko-agent" && raw.contains("relay=") -> Pair(raw)
                s == "nekko-agent" && host == "chat" && path.isNotEmpty() -> Chat(path.first())
                else -> null
            }
        }
    }
}
