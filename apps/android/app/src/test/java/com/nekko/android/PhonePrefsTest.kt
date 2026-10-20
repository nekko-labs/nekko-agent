package com.nekko.android

import com.nekko.android.data.ChatListFiles
import com.nekko.android.data.PhonePrefs
import com.nekko.android.data.PrefStore
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

/** In-memory stand-in for the SharedPreferences file. */
class MapPrefStore(val map: MutableMap<String, String> = mutableMapOf()) : PrefStore {
    override fun getString(name: String) = map[name]
    override fun putString(name: String, value: String?) {
        if (value == null) map.remove(name) else map[name] = value
    }
}

class PhonePrefsTest {
    private enum class Mode { QUIET, LOUD }

    private val haptics = PhonePrefs.boolean("haptics", default = true)
    private val lockAfter = PhonePrefs.long("lockAfterMs", default = 60_000L)
    private val mode = PhonePrefs.enum("mode", Mode.QUIET)

    @Test
    fun `unset keys read their default and write nothing`() {
        val store = MapPrefStore()
        val prefs = PhonePrefs(store)
        assertTrue(prefs.get(haptics))
        assertEquals(60_000L, prefs.flow(lockAfter).value)
        assertEquals(Mode.QUIET, prefs.get(mode))
        assertTrue(store.map.isEmpty())
    }

    @Test
    fun `set updates the flow and persists for the next launch`() {
        val store = MapPrefStore()
        val prefs = PhonePrefs(store)
        val flow = prefs.flow(haptics)
        prefs.set(haptics, false)
        assertFalse(flow.value)
        prefs.set(mode, Mode.LOUD)
        assertEquals(mapOf("haptics" to "false", "mode" to "LOUD"), store.map)

        val relaunched = PhonePrefs(store)
        assertFalse(relaunched.get(haptics))
        assertEquals(Mode.LOUD, relaunched.get(mode))
    }

    /** OF-9: the saved chat list is on unless the user turned it off. */
    @Test
    fun `the saved chat list is on by default and a deliberate off stays off`() {
        assertTrue(PhonePrefs(MapPrefStore()).get(ChatListFiles.ENABLED))
        assertFalse(PhonePrefs(MapPrefStore(mutableMapOf("keep_chat_list" to "false"))).get(ChatListFiles.ENABLED))
    }

    @Test
    fun `one flow per key`() {
        val prefs = PhonePrefs(MapPrefStore())
        assertSame(prefs.flow(haptics), prefs.flow(haptics))
    }

    @Test
    fun `values that no longer decode fall back to the default`() {
        val prefs = PhonePrefs(MapPrefStore(mutableMapOf("haptics" to "maybe", "lockAfterMs" to "soon", "mode" to "RETIRED")))
        assertTrue(prefs.get(haptics))
        assertEquals(60_000L, prefs.get(lockAfter))
        assertEquals(Mode.QUIET, prefs.get(mode))
    }

    @Test
    fun `reset forgets the stored value`() {
        val store = MapPrefStore()
        val prefs = PhonePrefs(store)
        prefs.set(lockAfter, 5_000L)
        prefs.reset(lockAfter)
        assertEquals(60_000L, prefs.get(lockAfter))
        assertNull(store.map["lockAfterMs"])
    }

    @Test(expected = IllegalStateException::class)
    fun `two keys with the same name are refused`() {
        val prefs = PhonePrefs(MapPrefStore())
        prefs.get(PhonePrefs.boolean("dup", true))
        prefs.get(PhonePrefs.string("dup", "x"))
    }

    @Test
    fun `phone prefs never share the appearance file`() {
        // ThemePrefs keeps "theme" in nekko_ui; PhonePrefs must not be able to clobber it.
        assertFalse(PhonePrefs.FILE == "nekko_ui")
    }
}
