package com.nekko.protocol

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class ProviderAccountsTest {
    private fun claude(label: String, account: ProviderAccount?) = PublicProvider("p", "claude-code", label, true, account)

    private val personal = claude("Claude subscription", ProviderAccount(true, "philip@example.test", "personal", "Personal", "max"))
    private val org = claude("Claude subscription · account-2", ProviderAccount(true, "philip@example.test", "organization", "Nekko Labs", "team"))

    @Test fun `a personal plan and an organization seat on one email read as two accounts`() {
        assertEquals("Personal · Max", ProviderAccounts.title(personal))
        assertEquals("philip@example.test · Personal plan", ProviderAccounts.caption(personal))
        assertEquals("Claude · Personal", ProviderAccounts.shortName(personal))

        assertEquals("Nekko Labs · Team", ProviderAccounts.title(org))
        assertEquals("philip@example.test · Organization", ProviderAccounts.caption(org))
        assertEquals("Claude · Nekko Labs", ProviderAccounts.shortName(org))
    }

    @Test fun `the plan is capitalised and left out when missing`() {
        val shouty = claude("x", ProviderAccount(true, "a@b.test", "personal", "Personal", "MAX"))
        assertEquals("Personal · Max", ProviderAccounts.title(shouty))
        val noPlan = claude("x", ProviderAccount(true, "a@b.test", "organization", "Nekko Labs"))
        assertEquals("Nekko Labs", ProviderAccounts.title(noPlan))
        assertEquals("a@b.test · Organization", ProviderAccounts.caption(noPlan))
    }

    @Test fun `signed out keeps the label and says so`() {
        val out = claude("Claude subscription · Work", ProviderAccount(false))
        assertEquals("Claude subscription · Work", ProviderAccounts.title(out))
        assertEquals("Signed out", ProviderAccounts.caption(out))
        assertEquals("Claude subscription · Work", ProviderAccounts.shortName(out))
        assertEquals("Abgemeldet", ProviderAccounts.caption(out, ProviderAccounts.Words(signedOut = "Abgemeldet")))
    }

    @Test fun `an API-key login or a provider without an account keeps its label`() {
        val apiKey = claude("Claude Code", ProviderAccount(true))
        assertEquals("Claude Code", ProviderAccounts.title(apiKey))
        assertNull(ProviderAccounts.caption(apiKey))
        assertEquals("Claude Code", ProviderAccounts.shortName(apiKey))

        val plain = PublicProvider("a", "anthropic", "Claude API", true)
        assertEquals("Claude API", ProviderAccounts.title(plain))
        assertNull(ProviderAccounts.caption(plain))
        assertEquals("Claude API", ProviderAccounts.shortName(plain))
    }

    @Test fun `an unknown scope shows the email alone, a missing name keeps the label`() {
        val odd = claude("Claude subscription", ProviderAccount(true, "a@b.test", "family", "Home", "max"))
        assertEquals("a@b.test", ProviderAccounts.caption(odd))
        assertEquals("Home · Max", ProviderAccounts.title(odd))
        val nameless = claude("Claude subscription", ProviderAccount(true, "a@b.test", "personal"))
        assertEquals("Claude subscription", ProviderAccounts.title(nameless))
        assertEquals("Claude subscription", ProviderAccounts.shortName(nameless))
        assertEquals("a@b.test · Personal plan", ProviderAccounts.caption(nameless))
    }

    @Test fun `search looks at the label, the email and the account name`() {
        assertEquals(
            listOf("Claude subscription · account-2", "philip@example.test", "Nekko Labs", "Nekko Labs · Team"),
            ProviderAccounts.searchable(org),
        )
        assertEquals(listOf("Claude API"), ProviderAccounts.searchable(PublicProvider("a", "anthropic", "Claude API", true)))
    }

    @Test fun `slider tabs name each account, and two that read the same by email`() {
        val a = PublicProvider("a", "claude-code", "Claude subscription", true, ProviderAccount(true, "a@example.test", "personal", "Personal", "max"))
        val b = PublicProvider("b", "claude-code", "Claude subscription · 2", true, ProviderAccount(true, "b@example.test", "personal", "Personal", "max"))
        val c = PublicProvider("c", "claude-code", "Claude subscription · 3", true, ProviderAccount(false))
        val o = PublicProvider("o", "claude-code", "Claude subscription · 4", true, ProviderAccount(true, "a@example.test", "organization", "Nekko Labs", "team"))
        assertEquals(mapOf("a" to "Personal · Max", "o" to "Nekko Labs · Team"), ProviderAccounts.tabLabels(listOf(a, o)))
        assertEquals(
            mapOf("a" to "a@example.test", "b" to "b@example.test", "c" to "Claude subscription · 3 · Signed out"),
            ProviderAccounts.tabLabels(listOf(a, b, c)),
        )
        // The line under the slider: whose login and which account; nothing for a signed-out one (its tab says so).
        assertEquals("a@example.test · Organization", ProviderAccounts.whoLine(o))
        assertNull(ProviderAccounts.whoLine(c))
    }
}
