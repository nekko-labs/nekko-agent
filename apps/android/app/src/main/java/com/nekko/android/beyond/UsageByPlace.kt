package com.nekko.android.beyond

import com.nekko.android.data.Caller
import com.nekko.android.data.PhonePrefs
import com.nekko.protocol.Channels
import com.nekko.protocol.PhoneUsageLedger
import com.nekko.protocol.ProviderLimits
import com.nekko.protocol.PublicProvider
import com.nekko.protocol.UsagePlace
import com.nekko.protocol.UsageSummary
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/**
 * Usage by place (#2114, the iPhone's FleetUsageModel, #1773): every online paired computer read in
 * parallel over its own connection (`usage:summary`, `providers:list`, `limits:get` per enabled
 * provider by id), then this phone's own chats. An offline computer, or one that answers with an
 * error, keeps the numbers it last gave (saved on this phone); nothing is sent to it.
 */
class UsageByPlaceController(
    /** The paired computers, in the app's order: id and name. */
    private val computers: () -> List<Pair<String, String>>,
    /** A computer's connection when it is online now, else null. */
    private val callerFor: (String) -> Caller?,
    /** This phone's own chats' usage; null when the phone runs no chats of its own. */
    private val phone: () -> PhoneUsageLedger?,
    private val prefs: PhonePrefs?,
    private val now: () -> Long = System::currentTimeMillis,
) {
    data class State(val places: List<UsagePlace> = emptyList(), val loaded: Boolean = false, val loading: Boolean = false)

    private val _state = MutableStateFlow(State())
    val state: StateFlow<State> = _state.asStateFlow()

    suspend fun load() {
        _state.update { it.copy(loading = true) }
        val last = prefs?.get(LAST)?.let { runCatching { Json.parseToJsonElement(it) as? JsonObject }.getOrNull() } ?: JsonObject(emptyMap())
        val fresh = HashMap<String, JsonElement>()
        val places = coroutineScope {
            computers().map { (id, name) ->
                async {
                    val c = callerFor(id)
                    val read = if (c == null) null else try {
                        read(c).also { fresh[id] = it }
                    } catch (e: CancellationException) {
                        throw e
                    } catch (e: Exception) {
                        return@async place(id, name, last[id], online = false, error = e.message ?: "Couldn’t read the usage.")
                    }
                    if (read != null) place(id, name, read, online = true, error = null) else place(id, name, last[id], online = false, error = null)
                }
            }.awaitAll()
        }
        prefs?.set(LAST, JsonObject(last + fresh).toString())
        val phonePlace = phone()?.takeIf { !it.isEmpty }?.place()
        _state.value = State(places + listOfNotNull(phonePlace), loaded = true, loading = false)
    }

    /** One computer's raw answers, kept as they came so the last ones can be shown offline. */
    private suspend fun read(c: Caller): JsonElement = coroutineScope {
        val summary = async { c.call(Channels.USAGE_SUMMARY) }
        val providersRaw = c.call(Channels.PROVIDERS_LIST)
        val enabled = PublicProvider.list(providersRaw).filter { it.enabled }
        // A provider without limits answers null; one that fails to read leaves no plan.
        val limits = enabled.map { p ->
            async {
                p.id to try { c.call(Channels.LIMITS_GET, JsonPrimitive(p.id)) } catch (e: CancellationException) { throw e } catch (_: Exception) { JsonNull }
            }
        }.awaitAll()
        buildJsonObject {
            put("at", now())
            put("summary", summary.await())
            put("providers", providersRaw)
            put("limits", JsonObject(limits.toMap()))
        }
    }

    companion object {
        /** Each computer's last answers, by id: what an offline computer shows. Only counts, labels and limits. */
        val LAST = PhonePrefs.string("usage.lastByComputer", "")

        /** A place from a computer's raw answers; with none, an empty place that says it is offline. */
        fun place(id: String, name: String, raw: JsonElement?, online: Boolean, error: String?): UsagePlace {
            val o = raw as? JsonObject ?: return UsagePlace(id, UsagePlace.Kind.COMPUTER, name, online = false, error = error)
            val providers = PublicProvider.list(o["providers"])
            val limits = (o["limits"] as? JsonObject).orEmpty().mapNotNull { (k, v) -> ProviderLimits.from(v)?.let { k to it } }.toMap()
            val at = (o["at"] as? JsonPrimitive)?.content?.toLongOrNull()
            return UsagePlace.computer(id, name, UsageSummary.from(o["summary"]), providers, limits, at).copy(online = online, error = error)
        }
    }
}
