package com.nekko.android.connection

import android.net.NetworkCapabilities
import com.nekko.android.BuildConfig
import com.nekko.protocol.NetworkPath
import com.nekko.protocol.RelayHint

/**
 * Which of a computer's relay routes this phone may dial (AN-28), by the
 * iPhone's rule (`RelayHint`): `wss://` anywhere, plain `ws://` to the
 * tailnet or the LAN, never to the open internet; a loopback relay only in
 * debug builds, where adb reverse forwards it.
 */
object RoutePolicy {
    fun allowed(url: String): Boolean = RelayHint.problem(url, BuildConfig.DEBUG) == null

    /** The kind of network, for the route choice: a LAN address only works on Wi-Fi or Ethernet. */
    fun path(caps: NetworkCapabilities?): NetworkPath = when {
        caps == null -> NetworkPath.UNKNOWN
        caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) || caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET) -> NetworkPath.LOCAL
        caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) -> NetworkPath.CELLULAR
        else -> NetworkPath.UNKNOWN
    }
}
