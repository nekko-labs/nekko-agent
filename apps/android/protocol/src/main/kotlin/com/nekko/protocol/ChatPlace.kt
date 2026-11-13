package com.nekko.protocol

/**
 * Where a chat runs: one paired computer, or this phone (the iPhone's `ChatPlace`, #1741).
 * The chat list holds every place's chats at once (#2108); each row names its place when there
 * is more than one, and the list can be grouped by place.
 */
data class ChatPlace(
    val id: String,
    val name: String,
    /** The computer's `machineIcon`; null shows a dot. Unused for the phone, which has its own mark. */
    val icon: String? = null,
    /** Its mark's colour (0xRRGGBB): [ComputerColors], by pairing order. */
    val color: Long = ComputerColors.PHONE,
) {
    val isPhone: Boolean get() = id == PHONE

    companion object {
        /** This phone's place id. */
        const val PHONE = "this-phone"

        /** Chats on this phone have ids that start with this (`PhoneChats.newChat`). */
        const val PHONE_CHAT_PREFIX = "phone:"

        fun isPhoneChat(id: String): Boolean = id.startsWith(PHONE_CHAT_PREFIX)

        /** A By computer group's key: stable across launches, so its fold is remembered. */
        fun groupKey(placeId: String): String = "computer:$placeId"
    }
}

/** The places' colours, the iPhone's `ComputerColors` (and the desktop's). */
object ComputerColors {
    val ALL = listOf(0x5b8defL, 0xa57cf0L, 0x2fb7b1L, 0xe26fb4L, 0x7f8cf5L, 0x8aa0b8L)

    /** This phone: the last colour, which no computer takes. */
    const val PHONE = 0x8aa0b8L

    /** A paired computer's, by its place among the paired computers. */
    fun computer(index: Int): Long = ALL[maxOf(0, index) % (ALL.size - 1)]
}
