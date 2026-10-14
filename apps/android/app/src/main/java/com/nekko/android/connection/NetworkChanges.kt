package com.nekko.android.connection

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
 */
class NetworkChanges(private val reconnect: () -> Unit) {
    private var current: Any? = null
    private var seenFirst = false

    fun onAvailable(network: Any) {
        val changed: Boolean
        synchronized(this) {
            changed = seenFirst && network != current
            current = network
            seenFirst = true
        }
        if (changed) reconnect()
    }

    fun onLost(network: Any) = synchronized(this) {
        // No default network now; the next one that appears is a change.
        if (network == current) current = null
        seenFirst = true
    }
}
