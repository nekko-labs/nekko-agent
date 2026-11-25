package com.nekko.protocol

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The iPhone's LimitLineTests and PhoneLimitLineTests (#2923), case for case. */
class LimitLineTest {
    private fun limits(vararg windows: Triple<String, Double, String>) = ProviderLimits.from(buildJsonObject {
        put("windows", JsonArray(windows.map { (id, used, status) ->
            buildJsonObject { put("id", id); put("label", id); put("usedPercent", JsonPrimitive(used)); put("status", status) }
        }))
    })

    @Test fun `no windows means no line`() {
        assertNull(LimitLine.tightest(null))
        assertNull(LimitLine.tightest(limits()))
    }

    @Test fun `the tightest window wins`() {
        val line = LimitLine.tightest(limits(Triple("5-hour", 34.0, "allowed"), Triple("Weekly", 61.0, "allowed")))
        assertEquals("Weekly", line?.window?.id)
        assertEquals(61, line?.percent)
        assertEquals(LimitLine.Level.QUIET, line?.level)
    }

    @Test fun `a limited window wins over a fuller one`() {
        val line = LimitLine.tightest(limits(Triple("5-hour", 99.0, "allowed"), Triple("Weekly", 40.0, "rate_limited")))
        assertEquals("Weekly", line?.window?.id)
        assertEquals(LimitLine.Level.REACHED, line?.level)
    }

    @Test fun levels() {
        assertEquals(LimitLine.Level.QUIET, LimitLine.tightest(limits(Triple("a", 74.4, "allowed")))?.level)
        assertEquals(LimitLine.Level.NEAR, LimitLine.tightest(limits(Triple("a", 75.0, "allowed")))?.level)
        assertEquals(LimitLine.Level.NEAR, LimitLine.tightest(limits(Triple("a", 20.0, "warning")))?.level)
        assertEquals(LimitLine.Level.REACHED, LimitLine.tightest(limits(Triple("a", 100.0, "allowed")))?.level)
    }

    @Test fun `phone budgets become windows used against their limit`() {
        val r = PhoneRateLimits(requestsLimit = 500, requestsRemaining = 499, requestsResetAt = 61_000,
            tokensLimit = 30_000, tokensRemaining = 26_400, tokensResetAt = 2_000, at = 1_000)
        val limits = r.providerLimits(now = 1_500)
        assertEquals(listOf("tokens", "requests"), limits.windows.map { it.id })
        assertEquals(12.0, limits.windows[0].usedPercent, 0.001)
        assertEquals(2_000L, limits.windows[0].resetAt)
        val line = LimitLine.tightest(limits)
        assertEquals("tokens", line?.window?.id)
        assertEquals(LimitLine.Level.QUIET, line?.level)
    }

    @Test fun `an empty phone budget is reached until it resets`() {
        val r = PhoneRateLimits(tokensLimit = 10_000, tokensRemaining = 0, tokensResetAt = 5_000, at = 1_000)
        assertEquals(LimitLine.Level.REACHED, LimitLine.tightest(r.providerLimits(now = 2_000))?.level)
        val after = r.providerLimits(now = 5_000)
        assertEquals(0.0, after.windows.first().usedPercent, 0.0)
        assertEquals(LimitLine.Level.QUIET, LimitLine.tightest(after)?.level)
    }

    @Test fun `a phone budget without a limit or remaining is left out`() {
        assertTrue(PhoneRateLimits(requestsLimit = 0, requestsRemaining = 0, at = 1).providerLimits(1).windows.isEmpty())
        assertTrue(PhoneRateLimits(tokensLimit = 1000, at = 1).providerLimits(1).windows.isEmpty())
        assertNull(LimitLine.tightest(PhoneRateLimits(at = 1).providerLimits(1)))
    }
}
