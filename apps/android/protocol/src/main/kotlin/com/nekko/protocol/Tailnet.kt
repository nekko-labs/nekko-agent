package com.nekko.protocol

/**
 * Whether this phone is on a Tailscale tailnet, read from its interface
 * addresses (no permission or Tailscale API needed): an IPv4 address in
 * 100.64.0.0/10 or an IPv6 address in fd7a:115c:a1e0::/48. Same check as the
 * iPhone app's `Tailnet.swift`. The app feeds it `NetworkInterface` addresses.
 */
object Tailnet {
    fun isConnected(addresses: List<String>): Boolean = addresses.any { isTailnetAddress(it) }

    fun isTailnetAddress(address: String): Boolean {
        val a = address.substringBefore('%').trim().lowercase() // drop an IPv6 zone (fe80::1%wlan0)
        if (RelayHint.isTailscaleIp(a)) return true
        return a.startsWith("fd7a:115c:a1e0:")
    }

    /** The relay is reached through the tailnet: a MagicDNS name or a tailnet address. */
    fun isTailnetRelay(relayUrl: String): Boolean {
        val h = RelayHint.host(relayUrl).removePrefix("[").removeSuffix("]")
        return h.endsWith(".ts.net") || h == "ts.net" || isTailnetAddress(h)
    }

    /**
     * What to tell the user when a tailnet relay can't be reached because
     * Tailscale is off on this phone, or null when that isn't the problem.
     */
    fun hint(relayUrl: String, phoneOnTailnet: Boolean, computer: String): String? =
        if (isTailnetRelay(relayUrl) && !phoneOnTailnet) {
            "Tailscale is off on this phone. Open the Tailscale app and connect to your tailnet to reach $computer."
        } else {
            null
        }
}
