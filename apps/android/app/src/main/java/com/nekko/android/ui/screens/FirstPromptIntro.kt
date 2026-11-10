package com.nekko.android.ui.screens

import android.graphics.SurfaceTexture
import android.media.MediaPlayer
import android.provider.Settings
import android.view.Surface
import android.view.TextureView
import androidx.annotation.RawRes
import androidx.annotation.StringRes
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.ui.graphics.luminance
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.sizeIn
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.compose.foundation.background
import androidx.compose.foundation.shape.CircleShape
import com.nekko.android.R
import com.nekko.android.data.PhonePrefs
import com.nekko.android.ui.theme.Nekko
import com.nekko.protocol.SessionSummary

/**
 * "Send your first prompt" (spec/chat/first-prompt-intro.md, #2234): the iPhone's three steps,
 * opened once over someone's first ever New chat. Each step is a short looping demo drawn on
 * Android's own screens (apps/desktop/scripts/first-prompt-intro-render/AndroidDemos.tsx,
 * rendered to res/raw), with its words underneath. Closing it any way marks it seen.
 */
object FirstPromptIntro {
    val SEEN = PhonePrefs.boolean("firstPromptIntroSeen", default = false)

    data class Step(val id: String, @StringRes val title: Int, @StringRes val body: Int)

    val steps = listOf(
        Step("start", R.string.intro_start_title, R.string.intro_start_body),
        Step("add", R.string.intro_add_title, R.string.intro_add_body),
        Step("send", R.string.intro_send_title, R.string.intro_send_body),
    )

    /**
     * Whether New chat opens it: not seen yet, the computer's list read (not the phone's saved copy),
     * and no chat with an exchange yet. A chat whose count the computer doesn't send counts as used,
     * so people who already chatted never see it (the iPhone's rule).
     */
    fun shouldShow(seen: Boolean, listLoaded: Boolean, chats: List<SessionSummary>): Boolean =
        !seen && listLoaded && chats.all { it.exchangeCount == 0L }

    @RawRes fun video(step: String, dark: Boolean): Int = when (step) {
        "start" -> if (dark) R.raw.first_prompt_start_dark else R.raw.first_prompt_start_light
        "add" -> if (dark) R.raw.first_prompt_add_dark else R.raw.first_prompt_add_light
        else -> if (dark) R.raw.first_prompt_send_dark else R.raw.first_prompt_send_light
    }

    /** With animations off (Settings → Accessibility → Remove animations) each demo holds one telling frame. */
    const val STILL_AT_MS = 3_300
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun FirstPromptIntroSheet(onDone: () -> Unit) {
    val p = Nekko.palette
    val sheet = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    var step by rememberSaveable { mutableIntStateOf(0) }
    val steps = FirstPromptIntro.steps
    val current = steps[step]
    val last = step == steps.lastIndex
    // The app's own theme (it can differ from the phone's), told by its paper.
    val dark = p.paper.luminance() < 0.5f
    // Swiping it away or Back counts as closing it, as on the iPhone.
    ModalBottomSheet(onDismissRequest = onDone, sheetState = sheet, containerColor = p.paper, modifier = Modifier.testTag("firstPromptIntro")) {
        Column(Modifier.fillMaxWidth().padding(horizontal = 20.dp).navigationBarsPadding().padding(bottom = 12.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
            Box(Modifier.fillMaxWidth().heightIn(min = 48.dp), contentAlignment = Alignment.Center) {
                // It opens on its own, so leaving it is always one tap.
                if (!last) TextButton(onClick = onDone, modifier = Modifier.align(Alignment.CenterStart).testTag("firstPromptIntro.skip")) { Text(stringResource(R.string.intro_skip)) }
                Text(stringResource(R.string.intro_title), style = MaterialTheme.typography.titleMedium, color = p.ink, modifier = Modifier.padding(horizontal = 72.dp),
                    textAlign = androidx.compose.ui.text.style.TextAlign.Center)
            }
            Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
                LoopingDemo(
                    FirstPromptIntro.video(current.id, dark),
                    Modifier.widthIn(max = 420.dp).fillMaxWidth().aspectRatio(360f / 400f).clip(RoundedCornerShape(16.dp))
                        .border(1.dp, p.line, RoundedCornerShape(16.dp))
                        // The words below say what the demo shows.
                        .clearAndSetSemantics { },
                )
            }
            Column(Modifier.semantics(mergeDescendants = true) { }.testTag("firstPromptIntro.step"), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Text(stringResource(current.title), style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold, color = p.ink)
                Text(stringResource(current.body), style = MaterialTheme.typography.bodyMedium, color = p.inkSoft)
            }
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                steps.forEachIndexed { i, s ->
                    val label = stringResource(R.string.intro_step, i + 1, stringResource(s.title))
                    Box(
                        Modifier.sizeIn(minWidth = 24.dp, minHeight = 48.dp).clickable { step = i }
                            .semantics { contentDescription = label; selected = i == step; role = Role.Tab },
                        contentAlignment = Alignment.Center,
                    ) {
                        Box(Modifier.height(7.dp).width(if (i == step) 18.dp else 7.dp).clip(CircleShape).background(if (i == step) p.accent else p.line))
                    }
                }
                Spacer(Modifier.weight(1f))
                if (step > 0) TextButton(onClick = { step-- }, modifier = Modifier.testTag("firstPromptIntro.back")) { Text(stringResource(R.string.intro_back)) }
                Button(
                    onClick = { if (last) onDone() else step++ },
                    colors = ButtonDefaults.buttonColors(containerColor = p.accent, contentColor = p.accentInk),
                    modifier = Modifier.heightIn(min = 48.dp).testTag(if (last) "firstPromptIntro.done" else "firstPromptIntro.next"),
                ) { Text(stringResource(if (last) R.string.intro_done else R.string.intro_next)) }
            }
        }
    }
}

/** A muted demo that loops with no controls; with animations off, one still frame. */
@Composable
private fun LoopingDemo(@RawRes video: Int, modifier: Modifier) {
    val context = LocalContext.current
    val still = Settings.Global.getFloat(context.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f) == 0f
    // A new view per step, so the old player is released with it.
    androidx.compose.runtime.key(video) {
        AndroidView(
            modifier = modifier,
            factory = { ctx ->
                TextureView(ctx).apply {
                    var player: MediaPlayer? = null
                    surfaceTextureListener = object : TextureView.SurfaceTextureListener {
                        override fun onSurfaceTextureAvailable(texture: SurfaceTexture, width: Int, height: Int) {
                            val afd = ctx.resources.openRawResourceFd(video) ?: return
                            player = MediaPlayer().apply {
                                setDataSource(afd.fileDescriptor, afd.startOffset, afd.length)
                                afd.close()
                                setSurface(Surface(texture))
                                // Never take the audio from music someone is playing: the demos are silent.
                                setVolume(0f, 0f)
                                isLooping = true
                                setOnPreparedListener { if (still) it.seekTo(FirstPromptIntro.STILL_AT_MS.toLong(), MediaPlayer.SEEK_CLOSEST) else it.start() }
                                prepareAsync()
                            }
                        }
                        override fun onSurfaceTextureSizeChanged(texture: SurfaceTexture, width: Int, height: Int) = Unit
                        override fun onSurfaceTextureDestroyed(texture: SurfaceTexture): Boolean {
                            player?.release(); player = null
                            return true
                        }
                        override fun onSurfaceTextureUpdated(texture: SurfaceTexture) = Unit
                    }
                }
            },
        )
    }
}
