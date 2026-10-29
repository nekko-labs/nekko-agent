package com.nekko.protocol

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
}
