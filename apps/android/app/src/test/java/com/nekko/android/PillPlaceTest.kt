package com.nekko.android

import com.nekko.android.data.PhonePrefs
import com.nekko.android.data.PillDock
import com.nekko.android.data.PillPlace
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** Where the floating mode pill comes to rest when let go, and how its place is saved. */
class PillPlaceTest {
    // A 1000 px wide screen; the pill can travel 800 px down; 72 dp is 200 px here.
    private fun release(x: Float, top: Float) = PillPlace.release(x, width = 1000f, top = top, room = 800f, snap = 200f)

    @Test
    fun `let go within 22 percent of a side it docks upright there at that height`() {
        assertEquals(PillPlace(PillDock.LEFT, 0.5f), release(x = 210f, top = 400f))
        assertEquals(PillPlace(PillDock.RIGHT, 0.25f), release(x = 790f, top = 200f))
        // Even right under the top bar, a side wins over going home.
        assertEquals(PillPlace(PillDock.LEFT, 0f), release(x = 10f, top = 0f))
    }

    @Test
    fun `let go in the middle it lies flat at that height`() {
        assertEquals(PillPlace(PillDock.TOP, 0.5f), release(x = 230f, top = 400f))
        assertEquals(PillPlace(PillDock.TOP, 0.75f), release(x = 770f, top = 600f))
    }

    @Test
    fun `let go flat within the snap distance of the top it goes home`() {
        assertEquals(PillPlace.DEFAULT, release(x = 500f, top = 200f))
        assertEquals(PillPlace.DEFAULT, release(x = 500f, top = 0f))
        assertTrue(release(x = 500f, top = 0f).atTop)
        assertFalse(release(x = 500f, top = 201f).atTop)
    }

    @Test
    fun `heights clamp between the top bar and the message box`() {
        assertEquals(PillPlace(PillDock.RIGHT, 1f), release(x = 990f, top = 5_000f))
        assertEquals(PillPlace(PillDock.LEFT, 0f), release(x = 0f, top = -300f))
        // No room to move (a tiny window): it rests at the top of what there is.
        assertEquals(PillPlace(PillDock.LEFT, 0f), PillPlace.release(0f, 1000f, 50f, room = 0f, snap = 200f))
    }

    @Test
    fun `the place is saved for the phone and read back`() {
        val store = MapPrefStore()
        PhonePrefs(store).set(PillPlace.KEY, PillPlace(PillDock.RIGHT, 0.4f))
        assertEquals("RIGHT:0.4", store.map["pill.place"])
        assertEquals(PillPlace(PillDock.RIGHT, 0.4f), PhonePrefs(store).get(PillPlace.KEY))
    }

    @Test
    fun `an unreadable or out-of-range place reads as home or clamps`() {
        assertEquals(PillPlace.DEFAULT, PhonePrefs(MapPrefStore()).get(PillPlace.KEY))
        for (bad in listOf("", "SIDEWAYS:0.5", "LEFT", "LEFT:abc", "LEFT:NaN")) {
            assertEquals(bad, PillPlace.DEFAULT, PhonePrefs(MapPrefStore(mutableMapOf("pill.place" to bad))).get(PillPlace.KEY))
        }
        assertEquals(PillPlace(PillDock.LEFT, 1f), PhonePrefs(MapPrefStore(mutableMapOf("pill.place" to "LEFT:3"))).get(PillPlace.KEY))
    }
}
