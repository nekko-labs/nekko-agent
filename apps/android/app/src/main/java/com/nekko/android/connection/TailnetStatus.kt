package com.nekko.android.connection

import com.nekko.protocol.Tailnet
import java.net.NetworkInterface

/** Whether this phone is on its tailnet right now: Tailscale's tunnel has a tailnet address. */
object TailnetStatus {
    fun phoneOnTailnet(): Boolean = try {
        val addresses = NetworkInterface.getNetworkInterfaces()?.toList().orEmpty()
            .filter { it.isUp }
            .flatMap { it.inetAddresses.toList() }
            .mapNotNull { it.hostAddress }
        Tailnet.isConnected(addresses)
    } catch (_: Exception) {
        // Unreadable: claim nothing rather than a wrong "Tailscale is off".
        true
    }
}
