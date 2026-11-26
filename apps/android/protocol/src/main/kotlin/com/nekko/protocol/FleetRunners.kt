package com.nekko.protocol

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.longOrNull

/**
 * The organizations' computers that run CI runners (decision 0064), as the paired computer reads
 * them from its sealed fleet and the phone gate lets through (the iPhone's FleetRunnerComputer).
 */
data class FleetRunnerComputer(
    val org: String,
    val deviceId: String,
    val name: String,
    val online: Boolean,
    val you: Boolean,
    val runners: List<Runner>,
) {
    data class Runner(val label: String, val state: String, val busy: Int, val slots: Int)

    val key get() = "$org/$deviceId"

    /** One line per runner, worded as the desktop's fleet view. None while offline: the state is stale. */
    val lines: List<String>
        get() = if (!online) emptyList() else runners.map { r ->
            val what = if (r.busy > 0) {
                "running ${if (r.busy == 1) "a job" else "${r.busy} jobs"} (${r.busy} of ${maxOf(r.slots, r.busy)} VMs)"
            } else when (r.state) {
                "off" -> "off"
                "waiting" -> "waiting"
                "ready" -> "ready (${r.slots} ${if (r.slots == 1) "VM" else "VMs"})"
                "running" -> "starting a job"
                "draining" -> "finishing a job"
                "cleaning" -> "cleaning up"
                "error" -> "needs attention"
                else -> r.state
            }
            "CI runner ${r.label}: $what"
        }

    companion object {
        /** Every computer with runners, in the order the computer listed them. Malformed rows are dropped. */
        fun list(e: JsonElement?): List<FleetRunnerComputer> {
            fun JsonElement?.obj() = this as? JsonObject
            fun JsonObject.str(k: String) = (this[k] as? JsonPrimitive)?.takeIf { it.isString }?.content
            fun JsonObject.arr(k: String) = (this[k] as? JsonArray).orEmpty()
            return e.obj()?.arr("orgs").orEmpty().mapNotNull { it.obj() }.flatMap { org ->
                org.arr("computers").mapNotNull { it.obj() }.mapNotNull { c ->
                    val id = c.str("deviceId") ?: return@mapNotNull null
                    val name = c.str("name") ?: return@mapNotNull null
                    val runners = c.arr("runners").mapNotNull { it.obj() }.mapNotNull { r ->
                        Runner(
                            r.str("label") ?: return@mapNotNull null,
                            r.str("state") ?: return@mapNotNull null,
                            ((r["busy"] as? JsonPrimitive)?.longOrNull ?: 0).toInt(),
                            ((r["slots"] as? JsonPrimitive)?.longOrNull ?: 0).toInt(),
                        )
                    }
                    if (runners.isEmpty()) null
                    else FleetRunnerComputer(
                        org.str("orgName").orEmpty(), id, name,
                        (c["online"] as? JsonPrimitive)?.booleanOrNull ?: false,
                        (c["you"] as? JsonPrimitive)?.booleanOrNull ?: false,
                        runners,
                    )
                }
            }
        }
    }
}
