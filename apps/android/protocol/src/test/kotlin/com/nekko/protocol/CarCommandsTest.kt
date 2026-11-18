package com.nekko.protocol

import java.io.File
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** The car grammar (#2782): every case in packages/shared/fixtures/car-commands.json, the iPhone's too. */
class CarCommandsTest {
    private val doc = generateSequence(File(System.getProperty("user.dir"))) { it.parentFile }
        .map { File(it, "packages/shared/fixtures/car-commands.json") }.first { it.isFile }
        .let { Json.parseToJsonElement(it.readText()).jsonObject }

    private fun JsonObject.s(k: String) = this[k]?.jsonPrimitive?.content

    private fun command(o: JsonObject): CarCommand {
        val chat = o.s("chat")
        return when (o.s("kind")) {
            "status" -> CarCommand.Status
            "read" -> CarCommand.Read(chat)
            "tell" -> CarCommand.Tell(chat, o.s("message").orEmpty())
            "allow" -> CarCommand.Allow(chat)
            "deny" -> CarCommand.Deny(chat)
            "stop" -> CarCommand.Stop(chat)
            "newChat" -> CarCommand.NewChat(o.s("message").orEmpty())
            "yes" -> CarCommand.Yes
            "no" -> CarCommand.No
            "pick" -> CarCommand.Pick(o["n"]!!.jsonPrimitive.int)
            "again" -> CarCommand.Again
            else -> CarCommand.Unknown(o.s("text").orEmpty())
        }
    }

    @Test fun everySharedUtterance() {
        val cases = doc["parse"]!!.jsonArray
        for (c in cases.map { it.jsonObject }) {
            val say = c.s("say")!!
            assertEquals(say, command(c["command"]!!.jsonObject), CarCommands.parse(say, inChat = c["inChat"]?.jsonPrimitive?.boolean == true))
        }
        assertTrue(cases.size >= 40)
    }

    @Test fun everySharedName() {
        fun names(v: kotlinx.serialization.json.JsonElement?) = v?.jsonArray.orEmpty().map { CarCommands.ChatName(it.jsonObject.s("id")!!, it.jsonObject.s("title")!!) }
        val defaults = names(doc["chats"])
        for (c in doc["matches"]!!.jsonArray.map { it.jsonObject }) {
            val m = c["match"]!!.jsonObject
            val ids = m["ids"]?.jsonArray.orEmpty().map { it.jsonPrimitive.content }
            val want = when (m.s("kind")) { "one" -> CarCommands.Match.One(ids.single()); "several" -> CarCommands.Match.Several(ids); else -> CarCommands.Match.None }
            assertEquals(c.s("query"), want, CarCommands.match(c.s("query")!!, if (c["chats"] == null) defaults else names(c["chats"])))
        }
    }
}
