package com.nekko.android.ui.chat

import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.unit.dp
import com.nekko.android.R
import com.nekko.android.ui.components.PixelCat
import com.nekko.android.ui.simple.rememberReduceMotion
import com.nekko.android.ui.theme.LocalSeasonalDecoration
import com.nekko.android.ui.theme.MascotHat
import com.nekko.android.ui.theme.SeasonalDecoration
import kotlinx.coroutines.delay

/**
 * Nekko beside a chat's title, the iPhone's `ChatMascot` (#1779, #2117): the desktop's pixel cat.
 * A tap says hello (it smiles for a moment); it never sends anything or changes a setting. While
 * the chat [working] it bobs; with animations off it holds still. TalkBack also offers [onRefresh]
 * as a Refresh action, as the iPhone's VoiceOver does.
 */
@Composable
fun ChatMascot(working: Boolean, refreshing: Boolean, onRefresh: () -> Unit, modifier: Modifier = Modifier) {
    val still = rememberReduceMotion()
    var greeting by remember { mutableStateOf(false) }
    var greetings by remember { mutableIntStateOf(0) }
    LaunchedEffect(greetings) {
        if (!greeting) return@LaunchedEffect
        delay(GREETING_MS)
        greeting = false
    }
    // The iPhone's 5 frames a second: up for two, down for two, while it works.
    var frame by remember { mutableIntStateOf(0) }
    LaunchedEffect(working, still) {
        frame = 0
        if (!working || still) return@LaunchedEffect
        while (true) {
            delay(200)
            frame = (frame + 1) % 4
        }
    }
    val hello = stringResource(R.string.mascot_say_hello)
    val state = stringResource(
        when {
            refreshing -> R.string.mascot_refreshing
            greeting -> R.string.mascot_hello
            working -> R.string.chats_working
            else -> R.string.chats_idle
        },
    )
    val refresh = stringResource(R.string.chat_refresh)
    Box(
        modifier
            .size(44.dp)
            .clickable(interactionSource = remember { MutableInteractionSource() }, indication = null) { greeting = true; greetings++ }
            .semantics {
                contentDescription = hello
                stateDescription = state
                role = Role.Button
                customActions = listOf(CustomAccessibilityAction(refresh) { onRefresh(); true })
            }
            .testTag("chat.mascot"),
        contentAlignment = Alignment.Center,
    ) {
        Box(Modifier.size(30.dp).offset(y = if (working && frame < 2) (-2).dp else 0.dp)) {
            PixelCat(Modifier.size(30.dp), happy = greeting || refreshing)
            val decoration = LocalSeasonalDecoration.current
            if (decoration != SeasonalDecoration.NONE) MascotHat(decoration, Modifier.size(30.dp))
        }
    }
}

private const val GREETING_MS = 1_200L
