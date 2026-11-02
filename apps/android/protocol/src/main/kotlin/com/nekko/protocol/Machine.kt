package com.nekko.protocol

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import java.time.Instant
import java.time.ZoneOffset

/**
 * What a computer says about itself for its page (`machine:summary`): the
 * daemon builds it without paths or addresses, and the phone shows it as is.
 * The iPhone's `MachineSummary`.
 */
data class MachineSummary(
    val version: String?,
    val platform: String?,
    val edition: String?,
    val uptimeMs: Long,
    val arch: String?,
    val release: String?,
    val cpuModel: String?,
    val cpuCores: Int?,
    val ramBytes: Double?,
    val unified: Boolean,
    val gpus: List<Gpu>,
    val backends: List<String>,
    val engineBackend: String?,
    val engineVersion: String?,
    val diskFreeBytes: Double?,
    val cpuPct: Double?,
    val memUsedMB: Double?,
    val memTotalMB: Double?,
    val cpuC: Double?,
    val gpuC: Double?,
    val gpuUsedMB: Double?,
    val gpuTotalMB: Double?,
    val serverRunning: Boolean,
    val serverStartedAt: Long?,
    val resident: List<ResidentModel>,
    val loading: Int,
) {
    data class Gpu(val name: String, val vramBytes: Double?, val cores: Int?)
    data class ResidentModel(val id: String, val name: String, val contextTokens: Int?)

    companion object {
        fun from(v: JsonElement?): MachineSummary? {
            val o = v.obj() ?: return null
            val hw = o["hardware"].obj()
            val live = o["live"].obj()
            val gpu = o["gpu"].obj()
            val engine = o["engine"].obj()
            val temps = live?.get("temps").obj()
            val cpu = hw?.get("cpu").obj()
            val gpus = hw?.get("gpus").arr().orEmpty().mapNotNull { g ->
                val go = g.obj() ?: return@mapNotNull null
                Gpu(go.str("name") ?: return@mapNotNull null, go.dbl("vramBytes"), go.long("cores")?.toInt())
            }
            val resident = engine?.get("resident").arr().orEmpty().mapNotNull { m ->
                val mo = m.obj() ?: return@mapNotNull null
                val id = mo.str("id") ?: return@mapNotNull null
                ResidentModel(id, mo.str("name") ?: id, mo.long("contextTokens")?.toInt())
            }
            // The hottest GPU the profile reports, else the system sensor.
            val gpuC = gpu?.get("devices").arr().orEmpty().mapNotNull { it.obj()?.dbl("temperatureC") }.maxOrNull() ?: temps?.dbl("gpuC")
            return MachineSummary(
                version = o.str("version"), platform = o.str("platform"), edition = o.str("edition"), uptimeMs = o.long("uptimeMs") ?: 0,
                arch = hw?.str("arch"), release = hw?.str("release"), cpuModel = cpu?.str("model") ?: live?.str("cpuModel"),
                cpuCores = (cpu?.long("cores") ?: live?.long("cpuCores"))?.toInt(), ramBytes = hw?.dbl("ramBytes"),
                unified = hw?.bool("unified") == true || gpu?.bool("unified") == true, gpus = gpus,
                backends = hw?.get("backends").arr().orEmpty().mapNotNull { (it as? JsonPrimitive)?.takeIf { p -> p.isString }?.contentOrNull },
                engineBackend = hw?.get("engine").obj()?.str("backend"), engineVersion = hw?.get("engine").obj()?.str("version"),
                diskFreeBytes = hw?.dbl("diskFreeBytes"),
                cpuPct = live?.dbl("cpuPct"), memUsedMB = live?.dbl("memUsedMB"), memTotalMB = live?.dbl("memTotalMB"),
                cpuC = temps?.dbl("cpuC"), gpuC = gpuC, gpuUsedMB = gpu?.dbl("usedMB"), gpuTotalMB = gpu?.dbl("totalMB"),
                serverRunning = engine?.bool("running") == true, serverStartedAt = engine?.long("startedAt"), resident = resident,
                loading = (engine?.long("loading") ?: 0).toInt(),
            )
        }
    }
}

/** One round trip to the computer, measured by the phone. */
data class RoundTrip(val at: Long, val ms: Int)

/** The ring of round trips a computer's page draws: the last [KEEP], newest last. */
object RoundTrips {
    const val KEEP = 20

    fun append(samples: List<RoundTrip>, sample: RoundTrip, keep: Int = KEEP): List<RoundTrip> = (samples + sample).takeLast(keep)

    /** The route's quality in a word, from the latest sample. */
    fun quality(ms: Int): String = when {
        ms < 80 -> "Fast"
        ms < 250 -> "Good"
        ms < 800 -> "Slow"
        else -> "Very slow"
    }

    /** The usage summary's day for [ms]: its rows are UTC dates. */
    fun dayKey(ms: Long): String = Instant.ofEpochMilli(ms).atZone(ZoneOffset.UTC).toLocalDate().toString()
}
