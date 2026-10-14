package com.nekko.android.connection

import com.nekko.android.data.PhonePrefs
import com.nekko.protocol.RelayState

/**
 * When the keep-alive foreground service should run: only while a chat on the
 * computer is mid-run or waiting on the user, the setting is on, and the relay
 * is (or is getting) online. Pure so it is JVM-tested.
 */
object KeepAlive {
    /** Settings → Connection → Stay connected while a chat runs. */
    val ENABLED = PhonePrefs.boolean("keep_connected", default = true)

    /**
     * A run that has said nothing for this long is treated as over: a missed
     * `done` (the phone slept through it) must not keep the service up for ever.
     */
    const val IDLE_LIMIT_MS = 30 * 60_000L

    fun wanted(enabled: Boolean, conn: RelayState, busyChats: Int, sinceLastEventMs: Long): Boolean =
        enabled &&
            busyChats > 0 &&
            (conn == RelayState.ONLINE || conn == RelayState.CONNECTING) &&
            sinceLastEventMs < IDLE_LIMIT_MS

    /** The ongoing notification's line, e.g. "1 chat running on Mac". */
    fun line(busyChats: Int, computer: String): String =
        if (busyChats == 1) "1 chat running on $computer" else "$busyChats chats running on $computer"
}
