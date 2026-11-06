package com.nekko.android.connection

import com.nekko.protocol.NetworkPath

/**
 * Decides when a change of the phone's default network should restart the
 * relay socket. Fed by `ConnectivityManager.registerDefaultNetworkCallback`
 * (see [NetworkWatcher]); pure so it runs on the JVM.
 *
 * A socket opened on Wi-Fi is dead once the phone is on mobile data, but
 * nothing says so until the next ping fails (up to ~50 s). So: reconnect as
 * soon as a different network becomes the default, or a network comes back
 * after there was none (airplane mode off). The first callback after
 * registering only reports the network the phone is already on.
 *
 * Each network also says its kind ([NetworkPath]), for the route choice
 * (AN-28): a change goes to [changed] with it, and a report of the network
 * the phone is already on goes to [same], which redials only if that moves
 * the route (the first report, or Wi-Fi capabilities arriving late).
 */
class NetworkChanges(
    private val same: (NetworkPath) -> Unit = {},
    private val changed: (NetworkPath) -> Unit,
) {
    private var current: Any? = null
    private var seenFirst = false

    fun onAvailable(network: Any, path: NetworkPath = NetworkPath.UNKNOWN) {
        val moved: Boolean
        synchronized(this) {
            moved = seenFirst && network != current
            current = network
            seenFirst = true
        }
        if (moved) changed(path) else same(path)
    }

    /** What the current network is changed (its capabilities came in). */
    fun onPath(network: Any, path: NetworkPath) {
        if (synchronized(this) { network == current }) same(path)
    }

    fun onLost(network: Any) = synchronized(this) {
        // No default network now; the next one that appears is a change.
        if (network == current) current = null
        seenFirst = true
    }
}
