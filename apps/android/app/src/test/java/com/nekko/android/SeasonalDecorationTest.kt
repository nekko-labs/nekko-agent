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

    @Test fun eightSeedsIncludeOneCatAndStayInBoundsOnPhoneOrFold() {
        assertEquals(8, WinterFlakes.COUNT)
        assertEquals(3, WinterFlakes.CAT_INDEX)
        for (seconds in listOf(0.0, 1.0, 30.0, 3600.0)) {
            for (index in 0 until WinterFlakes.COUNT) {
                val point = WinterFlakes.position(index, seconds)
                assertTrue(point.x > 0f && point.x < 1f)
                assertTrue(point.y >= 0f && point.y < 1f)
            }
        }
        assertEquals(0.0625f, WinterFlakes.position(0, 0.0).x, 0.00001f)
        assertEquals(0.06f, WinterFlakes.position(0, 0.0).y, 0.00001f)
        assertNotEquals(WinterFlakes.position(3, 0.0), WinterFlakes.position(3, 1.0))
    }
}
