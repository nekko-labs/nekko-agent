package com.nekko.protocol

import kotlinx.serialization.json.JsonObject

/**
 * The phone protocol version, sent in the HELLO (`PhoneProtocol.version` on the
 * iPhone, `PROTOCOL_VERSION` in crates/nekko-remote). 4 is the challenged
 * handshake with a `seq` on every request (relay replay protection); a phone
 * talking to a computer that never challenges it says [LEGACY].
 */
object PhoneProtocol {
    const val VERSION = 4

    /** What the HELLO says to a computer from before the challenge. */
    const val LEGACY = 3

    /** What the computer's welcome says, or 1 for a computer that sends nothing. */
    fun of(welcome: JsonObject): Int {
        val n = welcome.long("protocol") ?: return 1
        return if (n in 1 until 10_000) n.toInt() else 1
    }
}

/**
 * Which side to update when the phone and the computer speak different
 * versions (IO-32, the iPhone's `ProtocolCheck`).
 */
enum class ProtocolCheck {
    SAME,
    /** The computer is older: update Nekko Agent there. */
    UPDATE_COMPUTER,
    /** This app is older: update it. */
    UPDATE_PHONE;

    /** The banner's sentence, or null when nothing needs updating. */
    fun message(computer: String): String? = when (this) {
        SAME -> null
        UPDATE_COMPUTER -> "Nekko Agent on $computer is older than this app. Update it on the computer to use everything here."
        UPDATE_PHONE -> "This app is older than Nekko Agent on $computer. Update this app to use everything it offers."
    }

    companion object {
        /** [computer] is null until the computer has welcomed this phone. */
        fun compare(computer: Int?, phone: Int = PhoneProtocol.VERSION): ProtocolCheck = when {
            computer == null || computer == phone -> SAME
            computer < phone -> UPDATE_COMPUTER
            else -> UPDATE_PHONE
        }
    }
}
