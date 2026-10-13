package com.nekko.android.chat

import com.nekko.protocol.Approval
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull

private val prettyJson = Json { prettyPrint = true }

/** What the approval card shows in monospace: the exact command, else the raw tool input. */
fun approvalDetail(a: Approval): String {
    val command = (a.call.input["command"] as? JsonPrimitive)?.takeIf { it.isString }?.contentOrNull
    if (command != null) return command
    if (a.call.input.isEmpty()) return a.call.name
    return prettyJson.encodeToString(JsonElement.serializer(), a.call.input)
}
