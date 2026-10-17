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

    /**
     * The status-bar chip of the Live Update (Android 16+): the system shows
     * only a few characters there, so the count and nothing else.
     */
    fun chip(busyChats: Int): String = if (busyChats <= 1) "Running" else "$busyChats running"

    /** What the ongoing notification says while the service should run. */
    data class Status(val line: String, val chip: String)

    fun status(busyChats: Int, computer: String): Status = Status(line(busyChats, computer), chip(busyChats))

    /** Between the service starting and the first status (or the last one going away). */
    val FINISHING = Status("Finishing up", "Running")
}
