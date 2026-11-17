package com.nekko.android

import java.time.LocalDate
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** The Spooky theme's icon (#2118): October only, and only on the Spooky theme, as on the iPhone. */
class SpookyIconTest {
    @Test fun octoberOnTheSpookyThemeOnly() {
        assertTrue(SpookyIcon.wanted(true, LocalDate.of(2026, 10, 1)))
        assertTrue(SpookyIcon.wanted(true, LocalDate.of(2026, 10, 31)))
        assertFalse(SpookyIcon.wanted(true, LocalDate.of(2026, 11, 1)))
        assertFalse(SpookyIcon.wanted(true, LocalDate.of(2026, 9, 30)))
        assertFalse(SpookyIcon.wanted(false, LocalDate.of(2026, 10, 15)))
    }
}
