package com.nekko.protocol

import kotlin.math.roundToInt

/**
 * The one limit line under a chat's model (#2950, the iPhone's `LimitLine`, #2923): the provider's
 * tightest window, quiet below 75%, near from 75% (or when the provider warns), reached at 100%
 * or when limited.
 */
data class LimitLine(val window: ProviderLimits.Window) {
    enum class Level { QUIET, NEAR, REACHED }

    val level: Level get() = when {
        window.limited || window.usedPercent >= 100 -> Level.REACHED
        window.status == "warning" || window.usedPercent >= 75 -> Level.NEAR
        else -> Level.QUIET
    }

    /** Whole percent used, 0 to 100. */
    val percent: Int get() = window.usedPercent.roundToInt()

    companion object {
        /** Null when the provider reported no windows: no line, never a guess. */
        fun tightest(limits: ProviderLimits?): LimitLine? {
            val windows = limits?.windows?.takeIf { it.isNotEmpty() } ?: return null
            return LimitLine(windows.maxBy { if (it.limited) 101.0 else it.usedPercent })
        }
    }
}

/**
 * A phone key's token and request budgets as limit windows (#2923), each used against its limit.
 * A budget past its reset time is full again, so it reads as unused.
 */
fun PhoneRateLimits.providerLimits(now: Long): ProviderLimits {
    fun window(id: String, label: String, limit: Long?, remaining: Long?, resetAt: Long?): ProviderLimits.Window? {
        if (limit == null || limit <= 0 || remaining == null) return null
        if (resetAt != null && resetAt <= now) return ProviderLimits.Window(id, label, 0.0, null, "allowed")
        val used = (limit - minOf(remaining, limit)).toDouble() / limit * 100
        return ProviderLimits.Window(id, label, used, resetAt, if (remaining == 0L) "rate_limited" else "allowed")
    }
    val windows = listOfNotNull(
        window("tokens", "per-minute token", tokensLimit, tokensRemaining, tokensResetAt),
        window("requests", "per-minute request", requestsLimit, requestsRemaining, requestsResetAt),
    )
    return ProviderLimits(null, windows, at)
}
