package com.nekko.protocol

import java.util.Locale
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.longOrNull

/**
 * The Expert monitor (spec/phone/iphone-simple-and-expert-modes.md): the
 * computer's hardware, the Model Server's loaded models and a chat's context
 * window, each as the narrow view the computer sends a phone (`phoneSystemView`,
 * `phoneGpuView`, `phoneEngineView`, `phoneContextView` in
 * packages/shared/src/phone-views.ts). Mirrors the iPhone's HardwareMonitor.swift.
 */

/** The built-in Model Server's provider id (`PROVIDER_ID` in the desktop's ModelDock). */
const val ENGINE_PROVIDER_ID = "nekko-engine"

/** `system:stats`: CPU load and memory, with temperatures when the computer has sensors. */
data class SystemStats(
    val cpuPct: Double,
    val cpuCores: Int = 0,
    val memUsedMB: Double = 0.0,
    val memTotalMB: Double = 0.0,
    val cpuC: Double? = null,
    val memoryC: Double? = null,
    val gpuC: Double? = null,
) {
    /** Memory in use, 0..1; null when the computer reported no total. */
    val memFraction: Double? get() = if (memTotalMB > 0) (memUsedMB / memTotalMB).coerceIn(0.0, 1.0) else null

    companion object {
        /** Null without a CPU reading (an older computer, or not an object). */
        fun from(e: JsonElement?): SystemStats? {
            val o = e.obj() ?: return null
            val temps = o["temps"].obj()
            return SystemStats(
                cpuPct = o.dbl("cpuPct") ?: return null,
                cpuCores = o.long("cpuCores")?.toInt() ?: 0,
                memUsedMB = o.dbl("memUsedMB") ?: 0.0,
                memTotalMB = o.dbl("memTotalMB") ?: 0.0,
                cpuC = temps?.dbl("cpuC"),
                memoryC = temps?.dbl("memoryC"),
                gpuC = temps?.dbl("gpuC"),
            )
        }
    }
}

/** `gpu:stats`: the GPU memory pool and each device's load. */
data class GpuStats(
    val devices: List<Device> = emptyList(),
    val totalMB: Double = 0.0,
    val usedMB: Double = 0.0,
    /** One pool shared with the CPU (Apple Silicon): "GPU memory", not VRAM. */
    val unified: Boolean = false,
) {
    data class Device(val index: Int, val utilizationPct: Double? = null, val temperatureC: Double? = null)

    val memFraction: Double? get() = if (totalMB > 0) (usedMB / totalMB).coerceIn(0.0, 1.0) else null

    companion object {
        fun from(e: JsonElement?): GpuStats? {
            val o = e.obj() ?: return null
            val devices = o["devices"].arr().orEmpty().mapNotNull { it.obj() }.mapIndexed { i, d ->
                Device(i, d.dbl("utilizationPct"), d.dbl("temperatureC"))
            }
            return GpuStats(devices, o.dbl("totalMB") ?: 0.0, o.dbl("usedMB") ?: 0.0, o.bool("unified"))
        }
    }
}

/** `engine:status`: whether the Model Server runs, and what it holds in memory. */
data class EngineStatus(
    val installed: Boolean = false,
    val running: Boolean = false,
    val resident: List<Resident> = emptyList(),
    val loading: List<Loading> = emptyList(),
    /** What this computer can load models into (`EngineMemory`). */
    val budgetBytes: Long? = null,
    /** `vram`, `unified` or `ram`. */
    val memoryKind: String? = null,
) {
    /** A model the Model Server holds in memory (`ResidentModel`). */
    data class Resident(
        val id: String,
        val contextLength: Long? = null,
        /** GPU memory it takes, else its file size. */
        val bytes: Long? = null,
        /** `gpu` every layer offloaded, `cpu` none, `gpu+cpu` split; null when the runtime can't say. */
        val loadedOn: String? = null,
        val gpuLayers: Int? = null,
        val totalLayers: Int? = null,
    ) {
        /** Part of it runs on the CPU: slower, as the desktop warns. */
        val split: Boolean get() = loadedOn == "gpu+cpu" || loadedOn == "cpu"
    }

    /** [phase] is `queued` or `loading`; [progress] 0..1 when known. */
    data class Loading(val id: String, val phase: String, val progress: Double? = null)

    /** Memory the resident models take, of the budget, 0..1. */
    val memFraction: Double? get() {
        val budget = budgetBytes?.takeIf { it > 0 } ?: return null
        return (resident.sumOf { it.bytes ?: 0 }.toDouble() / budget).coerceAtMost(1.0)
    }

    companion object {
        fun from(e: JsonElement?): EngineStatus? {
            val o = e.obj() ?: return null
            val memory = o["memory"].obj()
            return EngineStatus(
                installed = o.bool("installed"),
                running = o.bool("running"),
                resident = o["resident"].arr().orEmpty().mapNotNull { r ->
                    val ro = r.obj() ?: return@mapNotNull null
                    Resident(
                        id = ro.str("id") ?: return@mapNotNull null,
                        contextLength = ro.long("contextLength"),
                        bytes = ro.long("vramBytes") ?: ro.long("sizeBytes"),
                        loadedOn = ro.str("loadedOn"),
                        gpuLayers = ro.long("gpuLayers")?.toInt(),
                        totalLayers = ro.long("totalLayers")?.toInt(),
                    )
                },
                loading = o["loading"].arr().orEmpty().mapNotNull { l ->
                    val lo = l.obj() ?: return@mapNotNull null
                    Loading(lo.str("id") ?: return@mapNotNull null, lo.str("phase") ?: "queued", lo.dbl("progress"))
                },
                budgetBytes = memory?.long("budgetBytes"),
                memoryKind = memory?.str("kind"),
            )
        }
    }
}

/** `context:preview`: how much of the chat's model window the next request fills. Totals only. */
data class ContextUsage(
    val usedTokens: Long,
    /** The model's window; null when the computer doesn't know it. */
    val contextWindow: Long? = null,
    /** Tokens per kind of source (`system`, `conversation`, `attached-file`, ...), biggest first. */
    val sources: List<Pair<String, Long>> = emptyList(),
) {
    /** 0..1 of the window; null without one. */
    val fraction: Double? get() = contextWindow?.takeIf { it > 0 }?.let { (usedTokens.toDouble() / it).coerceAtMost(1.0) }

    /** The composer gauge's colours (`fillTone`): a warning from 60%, danger from 85%. */
    val tone: MonitorTone get() = fraction.let { f ->
        when {
            f == null -> MonitorTone.OK
            f >= 0.85 -> MonitorTone.HOT
            f >= 0.6 -> MonitorTone.WARN
            else -> MonitorTone.OK
        }
    }

    companion object {
        fun from(e: JsonElement?): ContextUsage? {
            val o = e.obj() ?: return null
            val sources = o["sources"].obj().orEmpty().mapNotNull { (k, v) ->
                (v as? JsonPrimitive)?.longOrNull?.takeIf { it > 0 }?.let { k to it }
            }.sortedWith(compareByDescending<Pair<String, Long>> { it.second }.thenBy { it.first })
            return ContextUsage(o.long("usedTokens") ?: return null, o.long("contextWindow")?.takeIf { it > 0 }, sources)
        }
    }
}

/** The monitors' shared severity scale: quiet, warn, danger. */
enum class MonitorTone {
    OK, WARN, HOT;

    companion object {
        /** A load or fill fraction: warn above 70%, danger above 90% (the desktop's `loadColor`). */
        fun of(fraction: Double?): MonitorTone = when {
            fraction == null -> OK
            fraction > 0.9 -> HOT
            fraction > 0.7 -> WARN
            else -> OK
        }

        /** A temperature in °C (`temperatureTone`): warn from 80, danger from 90. */
        fun temperature(c: Double): MonitorTone = if (c >= 90) HOT else if (c >= 80) WARN else OK
    }
}

/** Counts as the desktop writes them (`formatContextTokens`, `formatBytes`). */
object MonitorFormat {
    /** 950, 12.3k, 128k, 1.05M. */
    fun tokens(n: Long): String = when {
        n >= 1_000_000 -> trim(String.format(Locale.US, "%.2f", n / 1_000_000.0)) + "M"
        n >= 100_000 -> String.format(Locale.US, "%.0f", n / 1000.0) + "k"
        n >= 1000 -> trim(String.format(Locale.US, "%.1f", n / 1000.0)) + "k"
        else -> n.toString()
    }

    /** 12.3k / 128k, just the tokens without a window, or – before the computer answers. */
    fun context(used: Long?, window: Long?): String = when {
        used == null -> "–"
        window == null -> tokens(used)
        else -> "${tokens(used)} / ${tokens(window)}"
    }

    /** 512 MB, 4.7 GB. */
    fun bytes(n: Long): String {
        val gb = n / 1_073_741_824.0
        return if (gb >= 1) trim(String.format(Locale.US, if (gb >= 10) "%.0f" else "%.1f", gb)) + " GB"
        else String.format(Locale.US, "%.0f", n / 1_048_576.0) + " MB"
    }

    /** MiB as the hardware monitor writes memory: 9.4 / 32 GB. */
    fun memory(usedMB: Double, totalMB: Double): String {
        fun f(mb: Double) = trim(String.format(Locale.US, if (mb / 1024 >= 10) "%.0f" else "%.1f", mb / 1024))
        return "${f(usedMB)} / ${f(totalMB)} GB"
    }

    /** 41%, or – without a reading. */
    fun percent(fraction: Double?): String = fraction?.let { "${Math.round(it * 100)}%" } ?: "–"

    private fun trim(s: String): String = if ('.' in s) s.trimEnd('0').trimEnd('.') else s
}

/**
 * How hard a model works per turn (`EffortLevel`, packages/shared/src/settings.ts)
 * and which levels a model takes (`modelEffortLevels`, model-capabilities.ts),
 * as the iPhone's ModelEffort.swift.
 */
enum class Effort(val wire: String) {
    LOW("low"), MEDIUM("medium"), NORMAL("normal"), HIGH("high"), XHIGH("xhigh"), MAX("max");

    companion object {
        fun parse(s: String?): Effort? = entries.firstOrNull { it.wire == s }

        /** The levels worth offering for a model, lowest first. */
        fun levels(modelId: String?): List<Effort> {
            val id = modelId.orEmpty()
            if (usesNativeEffort(id)) return listOf(LOW, MEDIUM, HIGH, XHIGH, MAX)
            return if (isOpenAIReasoning(id)) listOf(LOW, MEDIUM, NORMAL, HIGH) else listOf(LOW, NORMAL, HIGH)
        }

        private val CLAUDE = Regex("""^claude-(opus|sonnet|haiku|fable|mythos)-(\d+)(?:-(\d{1,2})(?!\d))?""")
        private val OPENAI = Regex("""(?:^|[-_/ .])(?:o[134](?:-|$)|gpt-?(?:[5-9]|\d{2,})(?:[.\-]|$)|gpt-oss|codex)""", RegexOption.IGNORE_CASE)

        /** Anthropic's `output_config.effort`: Claude from the 4.7 generation on, Fable and Mythos always. */
        internal fun usesNativeEffort(modelId: String): Boolean {
            var id = modelId.lowercase().trim()
            id = id.substringAfterLast('/')
            val at = id.indexOf("anthropic.")
            if (at >= 0 && id.startsWith("claude-", at + 10)) id = id.substring(at + 10)
            val m = CLAUDE.find(id) ?: return false
            val family = m.groupValues[1]
            if (family == "fable" || family == "mythos") return true
            val major = m.groupValues[2].toInt()
            val minor = m.groupValues[3].toIntOrNull() ?: 0
            return major > 4 || (major == 4 && minor >= 7)
        }

        internal fun isOpenAIReasoning(modelId: String): Boolean = OPENAI.containsMatchIn(modelId)
    }
}
