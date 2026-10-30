package com.nekko.android.connection

import android.net.NetworkCapabilities
import android.security.NetworkSecurityPolicy
import com.nekko.protocol.NetworkPath
import com.nekko.protocol.RelayRoute

/**
 * Which of a computer's relay routes this phone may dial (AN-28). The network
 * security config (`res/xml/network_security_config.xml`) allows plain
 * `ws://` only to the tailnet, so a computer's `ws://` LAN address is kept
 * but never dialed: it would fail on every try. `wss://` is always allowed.
 */
object RoutePolicy {
    fun allowed(url: String): Boolean {
        if (!url.trim().startsWith("ws://", ignoreCase = true)) return true
        val host = RelayRoute.host(url)
        return host.isNotEmpty() && NetworkSecurityPolicy.getInstance().isCleartextTrafficPermitted(host)
    }

    /** The kind of network, for the route choice: a LAN address only works on Wi-Fi or Ethernet. */
    fun path(caps: NetworkCapabilities?): NetworkPath = when {
        caps == null -> NetworkPath.UNKNOWN
        caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) || caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET) -> NetworkPath.LOCAL
        caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) -> NetworkPath.CELLULAR
        else -> NetworkPath.UNKNOWN
    }
}
