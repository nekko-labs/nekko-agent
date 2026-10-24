package com.nekko.protocol

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject

/**
 * `monitor:summary` as the phone receives it: the Monitors pane
 * (spec/phone/folding-phones-two-chats-and-monitors.md, *Panes*). The computer
 * projects it in `phoneMonitorView` (packages/shared/src/phone-views.ts) and
 * the daemon's twin (crates/nekko-remote/src/phone_views.rs), held to the phone
 * golden; this reads that shape and nothing more. A read-class channel: with
 * Read off the computer refuses it `read-off` ([PhoneRefusal]).
 *
 * Load, memory and temperatures only: no process names, no paths, no model
 * names. A field the computer left out reads as absent, never as an error.
 */
data class MonitorSummary(
    val hardware: Hardware = Hardware(),
    val running: List<Running> = emptyList(),
    val needsYou: List<NeedsYou> = emptyList(),
    val automations: List<Automation> = emptyList(),
) {
    data class Hardware(
        val cpu: Cpu = Cpu(),
        val memory: Memory = Memory(),
        /** Null without a GPU probe or sensor. */
        val gpu: Gpu? = null,
    )

    data class Cpu(val loadPct: Double = 0.0, val cores: Int = 0, val tempC: Double? = null)

    data class Memory(val usedMB: Double = 0.0, val totalMB: Double = 0.0, val tempC: Double? = null) {
        /** Used memory as a percentage of the total; 0 when the total is unknown. */
        val usedPct: Double get() = if (totalMB > 0) (usedMB / totalMB * 100).coerceIn(0.0, 100.0) else 0.0
    }

    data class Gpu(
        /** The busiest device's load. */
        val loadPct: Double? = null,
        /** The hottest device's temperature. */
        val tempC: Double? = null,
        val memoryUsedMB: Double? = null,
        val memoryTotalMB: Double? = null,
        /** Apple Silicon: the GPU shares the computer's memory. */
        val unified: Boolean = false,
    )

    /** What a working chat waits on. Coarse for now: the computer does not name the tool. */
    enum class Step(val wire: String) {
        APPROVAL("approval"),
        QUESTION("question"),
        WORKING("working"),
        ;

        companion object {
            fun parse(s: String?): Step = entries.firstOrNull { it.wire == s } ?: WORKING
        }
    }

    data class Running(
        val id: String,
        val title: String,
        val step: Step,
        /** Since the turn started, on the computer's clock; null when it didn't say. */
        val elapsedMs: Long? = null,
    )

    enum class Kind { APPROVAL, QUESTION }

    /** An approval or a question waiting across chats, oldest first. Never the tool's input or reason. */
    data class NeedsYou(
        val sessionId: String,
        val title: String,
        val kind: Kind,
        val callId: String,
        /** The tool's name for an approval; the first question for a question. */
        val label: String,
        /** An approval's risk; null for a question. */
        val risk: Severity? = null,
        /** How many questions the agent asked at once (a question only). */
        val count: Int = 0,
        /** When it started waiting, on the computer's clock. */
        val since: Long? = null,
    ) {
        /** Stable across polls: one approval or question per call. */
        val key: String get() = "$sessionId:${kind.name.lowercase()}:$callId"
    }

    enum class AutomationKind { TASK, WORKFLOW }

    data class Automation(val kind: AutomationKind, val id: String, val name: String, val nextRunAt: Long)

    /** A chat waiting on the owner, by id (the pane's status dot pulses for these). */
    val waiting: Set<String> get() = needsYou.mapTo(HashSet()) { it.sessionId }

    companion object {
        /** How often the Monitors pane reads `monitor:summary` while it is on screen; never in the background. */
        const val POLL_MS: Long = 10_000

        fun from(e: JsonElement?): MonitorSummary {
            val o = e.obj() ?: return MonitorSummary()
            return MonitorSummary(
                hardware = hardware(o["hardware"].obj()),
                running = o["running"].arr().orEmpty().mapNotNull { r ->
                    val ro = r.obj() ?: return@mapNotNull null
                    Running(
                        id = ro.str("id") ?: return@mapNotNull null,
                        title = ro.str("title").orEmpty(),
                        step = Step.parse(ro.str("step")),
                        elapsedMs = ro.long("elapsedMs")?.coerceAtLeast(0),
                    )
                },
                needsYou = o["needsYou"].arr().orEmpty().mapNotNull { n ->
                    val no = n.obj() ?: return@mapNotNull null
                    val kind = when (no.str("kind")) {
                        "approval" -> Kind.APPROVAL
                        "question" -> Kind.QUESTION
                        else -> return@mapNotNull null
                    }
                    NeedsYou(
                        sessionId = no.str("sessionId") ?: return@mapNotNull null,
                        title = no.str("title").orEmpty(),
                        kind = kind,
                        callId = no.str("callId") ?: return@mapNotNull null,
                        label = no.str("label").orEmpty(),
                        risk = if (kind == Kind.APPROVAL) Severity.parse(no.str("risk") ?: "medium") else null,
                        count = no.long("count")?.toInt() ?: 0,
                        since = no.long("since"),
                    )
                },
                automations = o["automations"].arr().orEmpty().mapNotNull { a ->
                    val ao = a.obj() ?: return@mapNotNull null
                    val kind = when (ao.str("kind")) {
                        "task" -> AutomationKind.TASK
                        "workflow" -> AutomationKind.WORKFLOW
                        else -> return@mapNotNull null
                    }
                    Automation(kind, ao.str("id") ?: return@mapNotNull null, ao.str("name").orEmpty(), ao.long("nextRunAt") ?: return@mapNotNull null)
                },
            )
        }

        private fun hardware(o: JsonObject?): Hardware {
            if (o == null) return Hardware()
            val cpu = o["cpu"].obj()
            val mem = o["memory"].obj()
            val gpu = o["gpu"].obj()
            return Hardware(
                cpu = Cpu(cpu?.dbl("loadPct") ?: 0.0, cpu?.long("cores")?.toInt() ?: 0, cpu?.dbl("tempC")),
                memory = Memory(mem?.dbl("usedMB") ?: 0.0, mem?.dbl("totalMB") ?: 0.0, mem?.dbl("tempC")),
                gpu = gpu?.let { g ->
                    Gpu(g.dbl("loadPct"), g.dbl("tempC"), g.dbl("memoryUsedMB"), g.dbl("memoryTotalMB"), g.bool("unified"))
                },
            )
        }

        /** "45s", "4m 12s", "1h 05m": how long a chat has been working. */
        fun elapsed(ms: Long): String {
            val s = (ms.coerceAtLeast(0) / 1000)
            return when {
                s < 60 -> "${s}s"
                s < 3600 -> "${s / 60}m ${(s % 60).toString().padStart(2, '0')}s"
                else -> "${s / 3600}h ${((s % 3600) / 60).toString().padStart(2, '0')}m"
            }
        }

        /** "now", "in 5m", "in 2h 10m", "in 3d": when an automation runs next. */
        fun nextRun(at: Long, now: Long): String {
            val m = Math.ceil((at - now) / 60_000.0).toLong()
            return when {
                m <= 0 -> "now"
                m < 60 -> "in ${m}m"
                m < 24 * 60 -> if (m % 60 == 0L) "in ${m / 60}h" else "in ${m / 60}h ${m % 60}m"
                else -> "in ${m / (24 * 60)}d"
            }
        }
    }
}
