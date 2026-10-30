package com.nekko.protocol

/**
 * How a relay address is reached. Mirrors `relayRoute` in
 * `packages/shared/src/relay-route.ts`, held to the golden
 * `crates/nekko-remote/tests/golden/relay-route.json`.
 */
enum class RelayRoute {
    /** A Tailscale MagicDNS name (`*.ts.net`) or a 100.64.0.0/10 address. */
    TAILSCALE,
    /** A private LAN address (RFC 1918, link-local, `.local`, IPv6 ULA). */
    LAN,
    /** `localhost`: the phone itself (the emulator reaches the computer another way). */
    LOOPBACK,
    /** Anything else: the hosted Nekko relay or a self-hosted public one. */
    INTERNET;

    companion object {
        fun of(relayUrl: String): RelayRoute {
            val h = host(relayUrl)
            if (h == "localhost" || h == "::1" || h.startsWith("127.")) return LOOPBACK
            if (h == "ts.net" || h.endsWith(".ts.net") || RelayHint.isTailscaleIp(h) || h.startsWith("fd7a:115c:a1e0:")) return TAILSCALE
            if (h.endsWith(".local") || isPrivateIPv4(h)) return LAN
            if (':' in h && (h.startsWith("fc") || h.startsWith("fd") || h.startsWith("fe80:"))) return LAN
            return INTERNET
        }

        /** `relayHost` in relay-route.ts: lowercased, IPv6 without brackets, past userinfo. */
        fun host(url: String): String {
            var s = url.trim().substringAfter("://")
            val authority = Regex("^[^/?#]*").find(s)?.value.orEmpty()
            val at = authority.lastIndexOf('@')
            if (at >= 0) s = s.substring(at + 1)
            if (s.startsWith("[")) {
                val end = s.indexOf(']')
                return if (end < 0) "" else s.substring(1, end).lowercase()
            }
            return (Regex("^[^/:?#]*").find(s)?.value.orEmpty()).lowercase()
        }

        private fun isPrivateIPv4(h: String): Boolean {
            val parts = h.split('.')
            if (parts.size != 4 || !parts.all { Regex("^\\d{1,3}$").matches(it) }) return false
            val n = parts.map { it.toInt() }
            if (n.any { it > 255 }) return false
            return n[0] == 10 || (n[0] == 172 && n[1] in 16..31) || (n[0] == 192 && n[1] == 168) || (n[0] == 169 && n[1] == 254)
        }
    }
}
