package com.nekko.protocol

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.float
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * Every row of the spec's posture table, iPad and Surface Duo cases, from the
 * fixture NekkoKit's PostureTests read too (`posture.json`).
 */
class PostureTest {
    private val text = javaClass.getResource("/posture.json")!!.readText()

    private fun windowClass(s: String) = WindowClass.valueOf(s.uppercase())

    private fun input(o: JsonObject): PostureInput {
        val f = { k: String -> o[k]!!.jsonPrimitive.float }
        val s = { k: String -> o[k]!!.jsonPrimitive.content }
        val hinge = o["hinge"]?.jsonObject?.let { h ->
            val b = h["bounds"]!!.jsonObject
            val bf = { k: String -> b[k]!!.jsonPrimitive.float }
            Hinge(
                bounds = Hinge.Bounds(bf("x"), bf("y"), bf("width"), bf("height")),
                state = if (h["state"]!!.jsonPrimitive.content == "halfOpened") Hinge.State.HALF_OPENED else Hinge.State.FLAT,
                orientation = Hinge.Orientation.valueOf(h["orientation"]!!.jsonPrimitive.content.uppercase()),
                isSeparating = h["isSeparating"]!!.jsonPrimitive.boolean,
            )
        }
        return PostureInput(f("widthDp"), f("heightDp"), windowClass(s("widthClass")), windowClass(s("heightClass")), hinge)
    }

    /** `openWide` -> `OPEN_WIDE`. */
    private fun posture(s: String) = Posture.valueOf(s.replace(Regex("([A-Z])"), "_$1").uppercase())

    @Test
    fun everyFixtureCase() {
        val cases = Json.parseToJsonElement(text).jsonObject["cases"]!!.jsonArray.map { it.jsonObject }
        assertTrue(cases.size >= 15)
        for (c in cases) {
            val name = c["name"]!!.jsonPrimitive.content
            assertEquals(name, posture(c["expected"]!!.jsonPrimitive.content), Posture.from(input(c["input"]!!.jsonObject)))
        }
        assertEquals(Posture.entries.toSet(), cases.map { posture(it["expected"]!!.jsonPrimitive.content) }.toSet())
    }

    @Test
    fun under600IsAlwaysClosed() {
        val fold = Hinge(Hinge.Bounds(0f, 400f, 599f, 0f), Hinge.State.HALF_OPENED, Hinge.Orientation.HORIZONTAL)
        assertEquals(Posture.CLOSED, Posture.from(PostureInput(599f, 800f, WindowClass.MEDIUM, WindowClass.MEDIUM, fold)))
    }

    @Test
    fun theFixtureIsTheSameAsTheIosCopy() {
        val root = System.getenv("NEKKO_REPO_ROOT") ?: return
        val ios = File(root, "apps/ios/Protocol/Tests/NekkoKitTests/Fixtures/posture.json")
        assertEquals(ios.readText(), text)
    }
}
