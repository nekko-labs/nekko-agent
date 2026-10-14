package com.nekko.android.data

import android.content.Context
import androidx.core.content.edit
import com.nekko.android.ui.theme.ThemeChoice
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/** The phone's own appearance choice. Not secret, so plain preferences (excluded from backup like the rest). */
class ThemePrefs(context: Context) {
    private val prefs = context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    private val _choice = MutableStateFlow(ThemeChoice.from(prefs.getString(KEY, null)))
    val choice: StateFlow<ThemeChoice> = _choice.asStateFlow()

    fun set(choice: ThemeChoice) {
        prefs.edit { putString(KEY, choice.id) }
        _choice.value = choice
    }

    private companion object {
        const val PREFS = "nekko_ui"
        const val KEY = "theme"
    }
}
