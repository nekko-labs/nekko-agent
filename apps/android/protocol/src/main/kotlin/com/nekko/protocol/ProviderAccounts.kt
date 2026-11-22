package com.nekko.protocol

/**
 * How a Claude subscription provider reads in the model pickers, so a personal
 * plan and an organization seat on the same email show as two clearly different
 * accounts. Same wording as the desktop (providerAccounts.ts) and the iPhone:
 * a group titled "Personal · Max" or "Nekko Labs · Team", a caption
 * "philip@example.test · Personal plan" or "… · Organization" under it, and
 * "Claude · Personal" where a short provider name sits next to a model.
 *
 * A provider without an [PublicProvider.account], or an API-key login (signed
 * in, no email), keeps its own label. A signed-out login keeps its label and
 * says "Signed out".
 */
object ProviderAccounts {
    /** The words the caption uses, translated by the app; English by default. */
    data class Words(
        val signedOut: String = "Signed out",
        val personalPlan: String = "Personal plan",
        val organization: String = "Organization",
    )

    /** The account's own name ("Personal", the organization), only for a plan login with an email. */
    fun name(provider: PublicProvider): String? {
        val a = provider.account ?: return null
        if (!a.signedIn || a.email == null) return null
        return a.name
    }

    /** "Personal · Max", "Nekko Labs · Team", or "Nekko Labs" with no plan; else the provider's label. */
    fun title(provider: PublicProvider): String {
        val name = name(provider) ?: return provider.label
        val plan = provider.account?.plan?.lowercase()?.replaceFirstChar { it.uppercase() }
        return listOfNotNull(name, plan).joinToString(" · ")
    }

    /** The line under [title]: the email and which account it is, or "Signed out"; null when there is nothing to say. */
    fun caption(provider: PublicProvider, words: Words = Words()): String? {
        val a = provider.account ?: return null
        if (!a.signedIn) return words.signedOut
        val email = a.email ?: return null
        val which = when (a.scope) {
            "organization" -> words.organization
            "personal" -> words.personalPlan
            else -> null
        }
        return listOfNotNull(email, which).joinToString(" · ")
    }

    /** A Claude subscription login. A computer's logins share one "Claude" group with a tab per account. */
    fun isClaudeLogin(provider: PublicProvider): Boolean = provider.kind == "claude-code"

    /**
     * Each login's tab in the account slider: [title] ("Personal · Max"), a
     * signed-out login's label with "Signed out" after it, and the email for two
     * accounts that would otherwise read the same (as the desktop's `disambiguate`).
     */
    fun tabLabels(providers: List<PublicProvider>, words: Words = Words()): Map<String, String> {
        val raw = providers.associate { p ->
            p.id to if (p.account?.signedIn == false) "${p.label} · ${words.signedOut}" else title(p)
        }
        return providers.associate { p ->
            val mine = raw.getValue(p.id)
            val clash = providers.any { it.id != p.id && raw[it.id] == mine }
            p.id to (if (clash) p.account?.email?.takeIf { name(p) != null } ?: mine else mine)
        }
    }

    /** The line under the slider for the account on show: its email and which account it is; null without an email. */
    fun whoLine(provider: PublicProvider, words: Words = Words()): String? =
        if (provider.account?.signedIn == true) caption(provider, words) else null

    /** "Claude · Personal" beside a model for a plan login with an email; else the provider's label. */
    fun shortName(provider: PublicProvider): String = name(provider)?.let { "Claude · $it" } ?: provider.label

    /** What a model search matches for this provider: its label, plus the account's email and name. */
    fun searchable(provider: PublicProvider): List<String> = listOfNotNull(
        provider.label,
        provider.account?.email,
        provider.account?.name,
        title(provider),
    ).distinct()
}
