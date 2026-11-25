package com.nekko.protocol

/**
 * Which kinds of route this phone may use to reach one paired computer (decision 0116, #3346), in the
 * names the desktop uses for a paired device's route. [AUTO] is either, [CLOUD] only Nekko Cloud
 * Relay (an internet route), [DIRECT] only Tailscale and the LAN. The computer enforces its own
 * choice at HELLO (`denied: route`); this is the phone's side, so it doesn't dial what is not wanted.
 */
enum class RouteChoice(val wire: String) {
    AUTO("auto"), CLOUD("cloud"), DIRECT("direct");

    /** Whether [url] is a route this choice dials. */
    fun keeps(url: String): Boolean = when (this) {
        AUTO -> true
        CLOUD -> RelayRoute.of(url) == RelayRoute.INTERNET
        DIRECT -> RelayRoute.of(url) != RelayRoute.INTERNET
    }

    /** The routes this choice dials, in order; every route when the filter would leave none. */
    fun filter(routes: List<String>): List<String> = routes.filter { keeps(it) }.ifEmpty { routes }

    /** Tailscale (and the LAN) is wanted. */
    val tailscale: Boolean get() = this != CLOUD
    /** Nekko Cloud Relay is wanted. */
    val cloud: Boolean get() = this != DIRECT

    companion object {
        /** Unknown or missing is [AUTO], so a save from before this existed keeps working. */
        fun parse(s: String?): RouteChoice = entries.firstOrNull { it.wire == s } ?: AUTO

        /** The choice two checkboxes make; both off can't happen, and says [AUTO]. */
        fun of(tailscale: Boolean, cloud: Boolean): RouteChoice = when {
            tailscale && !cloud -> DIRECT
            cloud && !tailscale -> CLOUD
            else -> AUTO
        }

        /** Whether the pairing carried a Tailscale/LAN route. */
        fun carriesTailscale(routes: List<String>): Boolean = routes.any { RelayRoute.of(it) != RelayRoute.INTERNET }

        /** Whether the pairing carried an internet route (Nekko Cloud Relay). */
        fun carriesCloud(routes: List<String>): Boolean = routes.any { RelayRoute.of(it) == RelayRoute.INTERNET }
    }
}
