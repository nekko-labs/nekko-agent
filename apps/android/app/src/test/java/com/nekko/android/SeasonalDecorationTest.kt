package com.nekko.android

import com.nekko.android.ui.theme.SeasonalDecoration
import com.nekko.android.ui.theme.ThemeChoice
import com.nekko.android.ui.theme.ThemePreset
import com.nekko.android.ui.theme.ThemeResolver
import com.nekko.android.ui.theme.WinterFlakes
import com.nekko.protocol.Appearance
import org.junit.Assert.*
import org.junit.Test

class SeasonalDecorationTest {
    @Test fun onlySeasonalPresetsDecorate() {
        assertEquals(SeasonalDecoration.WINTER, SeasonalDecoration.from(ThemePreset.find("winter")))
        assertEquals(SeasonalDecoration.SPOOKY, SeasonalDecoration.from(ThemePreset.find("autumn")))
        for (preset in ThemePreset.named.filter { it.id !in listOf("winter", "autumn") }) {
            assertEquals(preset.id, SeasonalDecoration.NONE, SeasonalDecoration.from(preset))
        }
        assertEquals(SeasonalDecoration.NONE, SeasonalDecoration.from(null))
    }

    @Test fun matchedComputerAndLocalChoiceUseTheSameDecoration() {
        for ((id, expected) in listOf("winter" to SeasonalDecoration.WINTER, "autumn" to SeasonalDecoration.SPOOKY, "dark" to SeasonalDecoration.NONE)) {
            val computer = ThemeResolver.resolve(ThemeChoice.COMPUTER, Appearance(preset = id), false)
            val local = ThemeResolver.resolve(ThemeChoice(id), null, false)
            assertEquals(expected, SeasonalDecoration.from(computer.preset))
            assertEquals(expected, SeasonalDecoration.from(local.preset))
        }
    }

    @Test fun tenSlowLargeFlakesInEightDesignsStayInBoundsOnPhoneOrFold() {
        assertEquals(10, WinterFlakes.COUNT)
        assertEquals(8, WinterFlakes.TYPE_COUNT)
        val types = mutableSetOf<Int>()
        for (seed in listOf(1L, 42L, 0xDEADBEEFL)) {
            for (index in 0 until WinterFlakes.COUNT) {
                assertEquals(WinterFlakes.flake(index, 0.0, seed), WinterFlakes.flake(index, 0.0, seed))
                assertNotEquals(WinterFlakes.flake(index, 0.0, seed).position, WinterFlakes.flake(index, 3.0, seed).position)
                val a = WinterFlakes.flake(index, 0.0, seed).position.y
                val b = WinterFlakes.flake(index, 1.0, seed).position.y
                if (b > a) assertTrue(b - a <= 1f / 48 + 1e-6f)
                for (seconds in listOf(0.0, 1.0, 30.0, 300.0, 3600.0)) {
                    val flake = WinterFlakes.flake(index, seconds, seed)
                    assertTrue(flake.position.x > 0f && flake.position.x < 1f)
                    assertTrue(flake.position.y >= 0f && flake.position.y < 1f)
                    assertTrue(flake.radius in 8f..14f)
                    types += flake.type
                }
            }
        }
        assertEquals((0 until 8).toSet(), types)
    }

    @Test fun hashMatchesIos() {
        assertEquals(0.20620949912738473, WinterFlakes.unit(42L, 3, 7, 4), 1e-12)
    }
}
