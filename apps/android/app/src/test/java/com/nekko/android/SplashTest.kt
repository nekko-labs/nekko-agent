package com.nekko.android

import com.nekko.android.lock.Ease
import com.nekko.android.lock.Splash
import com.nekko.android.lock.SplashCells
import java.io.File
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** #2120: the lock screen's pixel opening, the iPhone's (Splash.swift). */
class SplashTest {
    @Test fun `about a second in all, held on the cat until it may open`() {
        assertEquals(0.7f, Splash.ZOOM_AT, 1e-4f)
        assertEquals(0.994f, Splash.ZOOM_AT + Splash.ZOOM_FOR, 1e-3f)
        assertEquals(Splash.ZOOM_AT, Splash.limit(ready = false))
        assertEquals(Splash.ZOOM_AT + Splash.ZOOM_FOR, Splash.limit(ready = true))
    }

    @Test fun `the clock never skips the build after a stall and holds at its limit`() {
        // A long first frame (the prompt coming up) moves it a frame's worth, not half a second.
        assertEquals(Splash.MAX_STEP, Splash.advance(0f, 0.5f, Splash.limit(false)), 1e-6f)
        var t = 0f
        repeat(200) { t = Splash.advance(t, 1f / 60, Splash.limit(false)) }
        assertEquals(Splash.ZOOM_AT, t)
        repeat(200) { t = Splash.advance(t, 1f / 60, Splash.limit(true)) }
        assertEquals(Splash.ZOOM_AT + Splash.ZOOM_FOR, t)
        assertEquals(0.2f, Splash.advance(0.2f, -1f, 1f))
    }

    @Test fun `the zoom winds up a little, then grows to its reach`() {
        assertEquals(1f, Splash.zoomScale(0f, 100f))
        assertEquals(1f, Splash.zoomScale(Splash.ZOOM_AT, 100f))
        assertTrue(Splash.zoomScale(Splash.ZOOM_AT + 0.2f * Splash.ZOOM_FOR, 100f) < 1f)
        assertEquals(100f, Splash.zoomScale(Splash.ZOOM_AT + Splash.ZOOM_FOR, 100f), 0.01f)
    }

    @Test fun `the desktop's curves start at 0 and end at 1`() {
        for (f in listOf(Ease::out, Ease::inOut, Ease::windUp)) {
            assertEquals(0f, f(0f), 1e-3f)
            assertEquals(1f, f(1f), 1e-3f)
            assertTrue(f(0.5f) in 0f..1f)
        }
        assertTrue(Ease.out(0.3f) > 0.3f)
    }

    @Test fun `the cells are the iPhone's, from the same generator`() {
        val swift = generateSequence(File("").absoluteFile) { it.parentFile }
            .map { File(it, "apps/ios/App/Views/SplashCells.swift") }.first { it.isFile }.readText()
        fun quoted(name: String) = Regex("""$name = "([^"]+)"""").find(swift)!!.groupValues[1]
        assertEquals(quoted("brandHead"), SplashCells.BRAND_HEAD)
        assertEquals(quoted("midPath"), SplashCells.MID_PATH)
        assertEquals(quoted("finePath"), SplashCells.FINE_PATH)
        val cells = Regex("""\(([-\d.]+), ([-\d.]+)\)""").findAll(swift.substringAfter("chunkyCells: [(Double, Double)] = [").substringBefore("]"))
            .flatMap { sequenceOf(it.groupValues[1].toFloat(), it.groupValues[2].toFloat()) }.toList().toFloatArray()
        assertArrayEquals(cells, SplashCells.CHUNKY_CELLS, 0f)
        assertEquals(Regex("""chunkySize = ([\d.]+)""").find(swift)!!.groupValues[1].toFloat(), SplashCells.CHUNKY_SIZE)
    }
}
