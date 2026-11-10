package com.nekko.protocol

import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.ZoneOffset

/** #2114: usage by place, the iPhone's UsageByPlaceTests (#1773). */
class UsageByPlaceTest {
    private val summary = UsageSummary(
        totalInput = 9_000, totalOutput = 1_000, totalCost = 2.5,
        models = listOf(UsageSummary.Model("claude-opus", 4_000, 1_000, 0.0, true), UsageSummary.Model("gpt-5", 2_000, 0, 2.5, false)),
        days = emptyList(),
    )
    private val limits = ProviderLimits("max", listOf(ProviderLimits.Window("w", "5 hours", 40.0, null, "allowed")), null)
    private val providers = listOf(PublicProvider("claude", "anthropic", "Claude", true), PublicProvider("off", "anthropic", "Off", false), PublicProvider("openai", "openai", "OpenAI", true))

    @Test fun `a computer's subscriptions come first, then API use and its spend`() {
        val p = UsagePlace.computer("mac", "Mac", summary, providers, mapOf("claude" to limits, "off" to limits), readAt = 1)
        assertEquals("Only enabled providers that reported limits are plans", listOf("Claude · Max"), p.plans.map { it.title })
        assertEquals(5_000L, p.subscriptionTokens)
        assertEquals("API tokens are the rest of the total (the computer sends its busiest models only)", 5_000L, p.apiTokens)
        assertEquals(listOf("gpt-5"), p.apiGroups.single().models.map { it.model })
        assertEquals(2.5, p.apiCost!!, 0.0)
        assertTrue(p.priced)
    }

    @Test fun `all places add up and count the offline ones`() {
        val mac = UsagePlace.computer("mac", "Mac", summary, providers, emptyMap(), null)
        val pc = UsagePlace("pc", UsagePlace.Kind.COMPUTER, "PC", online = false, summary = summary)
        val phone = PhoneUsageLedger().record("anthropic", "Claude", "haiku", 300, 200, 0, ZoneOffset.UTC).place()
        val t = UsageTotals.of(listOf(mac, pc, phone))
        assertEquals(20_500L, t.tokens)
        assertEquals(10_000L, t.subscriptionTokens)
        assertEquals(10_500L, t.apiTokens)
        assertEquals("This phone has no prices", 5.0, t.apiCost, 0.0)
        assertEquals(1, t.offline)
    }

    @Test fun `the phone's ledger adds by provider, model and day, keeps 90 days, and groups by provider`() {
        val day = 86_400_000L
        var l = PhoneUsageLedger()
            .record("a", "Claude", "haiku", 100, 50, 0, ZoneOffset.UTC)
            .record("a", "Claude (work)", "haiku", 10, 5, 1000, ZoneOffset.UTC)
            .record("o", "OpenAI", "gpt", 1, 1, 0, ZoneOffset.UTC)
            .record("a", "Claude", "haiku", 0, 0, 0, ZoneOffset.UTC)
        assertEquals("Same model, same day: one entry", 2, l.entries.size)
        assertEquals(110L to 55L, l.entries.first().let { it.input to it.output })
        assertEquals("The provider's name as last used", "Claude (work)", l.entries.first().providerLabel)
        val place = l.place()
        assertEquals(listOf("Claude (work)", "OpenAI"), place.apiGroups.map { it.label })
        assertNull(place.apiCost)
        assertEquals(167L, place.totalTokens)
        l = l.record("o", "OpenAI", "gpt", 1, 1, 91 * day, ZoneOffset.UTC)
        assertEquals("Entries older than 90 days go", listOf("1970-04-02"), l.entries.map { it.day })
        assertTrue(PhoneUsageLedger().place().summary == null)
    }

    @Test fun `the ledger file reads back, and a broken one reads as empty`() {
        val l = PhoneUsageLedger().record("a", "Claude", "haiku", 100, 50, 0, ZoneOffset.UTC)
        assertEquals(l, PhoneUsageLedger.from(Json.parseToJsonElement(l.json().toString())))
        assertTrue(PhoneUsageLedger.from(Json.parseToJsonElement("""{"nope":1}""")).isEmpty)
        assertEquals(1, PhoneUsageLedger.from(Json.parseToJsonElement("""[{"providerId":"a","model":"m","day":"2026-11-10","input":3},{"model":"x"}]""")).entries.size)
    }

    private fun events(vararg lines: String): List<PhoneStreamEvent> { val p = PhoneStreamParser(); return lines.flatMap { p.line(it) } }

    @Test fun `the phone's stream reports Anthropic's tokens, cache included, and the output's running total`() {
        val e = events(
            "event: message_start", """data: {"type":"message_start","message":{"usage":{"input_tokens":120,"cache_creation_input_tokens":30,"cache_read_input_tokens":50,"output_tokens":1}}}""", "",
            """data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hi"}}""", "",
            """data: {"type":"message_delta","usage":{"output_tokens":42}}""", "",
        )
        val usage = e.filterIsInstance<PhoneStreamEvent.Usage>()
        assertEquals(PhoneStreamEvent.Usage(200, 1), usage.first())
        assertEquals(PhoneStreamEvent.Usage(null, 42), usage.last())
        assertEquals(listOf("Hi"), e.filterIsInstance<PhoneStreamEvent.Text>().map { it.text })
    }

    @Test fun `the phone's stream reports OpenAI's last chunk, and ignores what is not a count`() {
        val e = events("""data: {"choices":[],"usage":{"prompt_tokens":15,"completion_tokens":7}}""", "", """data: {"choices":[{"delta":{"content":"x"}}],"usage":{"prompt_tokens":"lots"}}""", "")
        assertEquals(listOf(PhoneStreamEvent.Usage(15, 7)), e.filterIsInstance<PhoneStreamEvent.Usage>())
        assertFalse(e.any { it is PhoneStreamEvent.Failure })
    }
}
