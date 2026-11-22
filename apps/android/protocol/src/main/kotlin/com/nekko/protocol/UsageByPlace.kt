package com.nekko.protocol

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.time.Instant
import java.time.ZoneId

/**
 * Usage by place (#2114, the iPhone's #1773): one place per paired computer, and this phone. Within
 * a place, subscriptions (an enabled provider that reported limits, and the models that bill to a
 * plan) come before pay-per-token API use. Pure, as the iPhone's `UsagePlace` in NekkoProtocol.
 */
data class UsagePlace(
    val id: String,
    val kind: Kind,
    /** The computer's name; empty for this phone (the app names it). */
    val name: String,
    /** The place answered this time. An offline computer keeps the numbers it last gave. */
    val online: Boolean,
    val summary: UsageSummary? = null,
    val plans: List<Plan> = emptyList(),
    /** This phone's API use by provider; a computer's comes from its summary. */
    val phoneGroups: List<ApiGroup> = emptyList(),
    /** Why the place could not be read, when it could not. */
    val error: String? = null,
    /** When these numbers were read, for an offline computer's last ones (ms). */
    val readAt: Long? = null,
) {
    enum class Kind { COMPUTER, PHONE }

    /** A subscription plan: an enabled provider that reported limits. */
    data class Plan(val providerId: String, val label: String, val limits: ProviderLimits) {
        /** The heading: `Claude · Max`. */
        val title: String get() = listOfNotNull(label, limits.planType?.takeIf { it.isNotEmpty() }?.replaceFirstChar { it.uppercase() }).joinToString(" · ")
    }

    /** Pay-per-token models, under the provider they bill to when the place knows it (this phone does). */
    data class ApiGroup(val label: String?, val models: List<UsageSummary.Model>) {
        val tokens: Long get() = models.sumOf { it.tokens }
    }

    /** A computer has prices; this phone has none, so it shows tokens only. */
    val priced: Boolean get() = kind == Kind.COMPUTER

    /** The models that bill to a subscription, busiest first. */
    val subscriptionModels: List<UsageSummary.Model> get() = summary?.models.orEmpty().filter { it.subscription }

    val apiGroups: List<ApiGroup>
        get() {
            if (kind == Kind.PHONE) return phoneGroups.filter { it.models.isNotEmpty() }
            val models = summary?.models.orEmpty().filter { !it.subscription }
            return if (models.isEmpty()) emptyList() else listOf(ApiGroup(null, models))
        }

    val totalTokens: Long get() = summary?.totalTokens ?: 0
    /** Tokens on a subscription, from the models listed (a computer sends its busiest only). */
    val subscriptionTokens: Long get() = subscriptionModels.sumOf { it.tokens }
    val apiTokens: Long get() = (totalTokens - subscriptionTokens).coerceAtLeast(0)
    /** Estimated API spend: the computer counts subscription models at zero; null where there are no prices. */
    val apiCost: Double? get() = if (priced) summary?.totalCost ?: 0.0 else null
    val isEmpty: Boolean get() = totalTokens == 0L && plans.isEmpty()

    companion object {
        /** A computer's place from what it answered: limits only for its enabled providers, in their order. */
        fun computer(id: String, name: String, summary: UsageSummary?, providers: List<PublicProvider>, limits: Map<String, ProviderLimits>, readAt: Long?) =
            UsagePlace(
                id = id, kind = Kind.COMPUTER, name = name, online = true, summary = summary, readAt = readAt,
                plans = providers.filter { it.enabled }.mapNotNull { p -> limits[p.id]?.let { Plan(p.id, ProviderAccounts.shortName(p), it) } },
            )
    }
}

/** Every place's usage added up: the All places total at the top. */
data class UsageTotals(val tokens: Long, val subscriptionTokens: Long, val apiTokens: Long, val apiCost: Double, val offline: Int) {
    companion object {
        fun of(places: List<UsagePlace>) = UsageTotals(
            tokens = places.sumOf { it.totalTokens },
            subscriptionTokens = places.sumOf { it.subscriptionTokens },
            apiTokens = places.sumOf { it.apiTokens },
            apiCost = places.sumOf { it.apiCost ?: 0.0 },
            offline = places.count { !it.online },
        )
    }
}

/**
 * What this phone's own chats used: tokens per provider, model and local day, as each provider's
 * stream reported them. Kept on the phone, never sent anywhere. No price table, so tokens only.
 * The iPhone's `PhoneUsageLedger`.
 */
data class PhoneUsageLedger(val entries: List<Entry> = emptyList()) {
    data class Entry(val providerId: String, val providerLabel: String, val model: String, val day: String, val input: Long, val output: Long)

    val isEmpty: Boolean get() = entries.isEmpty()

    /** One reply's tokens added; entries older than [KEEP_DAYS] go. */
    fun record(providerId: String, providerLabel: String, model: String, input: Long, output: Long, atMs: Long, zone: ZoneId = ZoneId.systemDefault()): PhoneUsageLedger {
        if (input <= 0 && output <= 0) return this
        val day = day(atMs, zone)
        val i = entries.indexOfFirst { it.providerId == providerId && it.model == model && it.day == day }
        val next = if (i >= 0) entries.toMutableList().also { val e = it[i]; it[i] = e.copy(input = e.input + input, output = e.output + output, providerLabel = providerLabel) }
        else entries + Entry(providerId, providerLabel, model, day, input, output)
        val oldest = day(atMs - KEEP_DAYS * 86_400_000L, zone)
        return PhoneUsageLedger(next.filter { it.day >= oldest })
    }

    /** The ledger as a place: every model is pay-per-token, under its provider, busiest first. */
    fun place(name: String = "", online: Boolean = true): UsagePlace {
        val totals = entries.groupBy { it.providerId }.mapValues { (_, es) -> es.sumOf { it.input + it.output } }
        val providers = totals.keys.sortedWith(compareByDescending<String> { totals.getValue(it) }.thenBy { it })
        val groups = providers.map { pid ->
            val mine = entries.filter { it.providerId == pid }
            val models = mine.groupBy { it.model }.map { (m, es) -> UsageSummary.Model(m, es.sumOf { it.input }, es.sumOf { it.output }, 0.0, false) }
                .sortedWith(compareByDescending<UsageSummary.Model> { it.tokens }.thenBy { it.model })
            UsagePlace.ApiGroup(mine.last().providerLabel, models)
        }
        val byDay = entries.groupBy { it.day }.mapValues { (_, es) -> es.sumOf { it.input + it.output } }
        val days = byDay.keys.sorted().takeLast(SHOWN_DAYS).map { UsageSummary.Day(it, byDay.getValue(it), 0.0) }
        val summary = UsageSummary(entries.sumOf { it.input }, entries.sumOf { it.output }, 0.0, groups.flatMap { it.models }, days)
        return UsagePlace(PHONE_ID, UsagePlace.Kind.PHONE, name, online, summary.takeIf { entries.isNotEmpty() }, phoneGroups = groups)
    }

    fun json(): JsonArray = buildJsonArray {
        entries.forEach { e ->
            add(buildJsonObject {
                put("providerId", e.providerId); put("providerLabel", e.providerLabel); put("model", e.model)
                put("day", e.day); put("input", e.input); put("output", e.output)
            })
        }
    }

    companion object {
        const val PHONE_ID = "phone"
        /** Days kept: older entries go when a new one is recorded. */
        const val KEEP_DAYS = 90
        /** Days the Usage screen lists, as a computer's summary sends. */
        const val SHOWN_DAYS = 14

        fun day(ms: Long, zone: ZoneId): String = Instant.ofEpochMilli(ms).atZone(zone).toLocalDate().toString()

        /** Anything unreadable is left out; a broken file reads as empty. */
        fun from(v: kotlinx.serialization.json.JsonElement?): PhoneUsageLedger = PhoneUsageLedger(
            (v as? JsonArray).orEmpty().mapNotNull { e ->
                val o = e as? JsonObject ?: return@mapNotNull null
                fun s(k: String) = (o[k] as? JsonPrimitive)?.takeIf { it.isString }?.content
                fun n(k: String) = (o[k] as? JsonPrimitive)?.content?.toLongOrNull()?.takeIf { it >= 0 }
                Entry(s("providerId") ?: return@mapNotNull null, s("providerLabel") ?: "", s("model") ?: return@mapNotNull null,
                    s("day") ?: return@mapNotNull null, n("input") ?: 0, n("output") ?: 0)
            },
        )
    }
}
