package com.nekko.android.voice

import androidx.compose.runtime.Composable
import androidx.compose.ui.res.stringResource
import com.nekko.android.R

@Composable
fun voiceLabels() = VoiceLabels(
    title = stringResource(R.string.voice_conversation),
    explanation = stringResource(R.string.voice_explanation),
    start = stringResource(R.string.voice_start), stop = stringResource(R.string.voice_stop),
    close = stringResource(R.string.voice_close), settings = stringResource(R.string.voice_settings),
    permissionGranted = stringResource(R.string.voice_permission_granted),
    permissionDenied = stringResource(R.string.voice_permission_denied),
    unavailable = stringResource(R.string.voice_unavailable), ready = stringResource(R.string.voice_ready),
    listening = stringResource(R.string.voice_listening), waiting = stringResource(R.string.voice_waiting),
    speaking = stringResource(R.string.voice_speaking), stopped = stringResource(R.string.voice_stopped),
    heard = stringResource(R.string.voice_heard), reply = stringResource(R.string.voice_reply),
)
