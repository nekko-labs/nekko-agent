package com.nekko.android.ui.settings

import com.nekko.android.R
import androidx.compose.ui.res.stringResource
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Feedback
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.nekko.android.ui.components.NCard
import com.nekko.android.ui.components.SectionHeader

/** Settings → Feedback: opens [FeedbackSheet]. Sits just above About. */
@Composable
fun FeedbackSection(@Suppress("UNUSED_PARAMETER") deps: SettingsDeps) {
    var open by rememberSaveable { mutableStateOf(false) }
    SectionHeader(stringResource(R.string.settings_feedback))
    Column(Modifier.padding(horizontal = 16.dp)) {
        NCard {
            SettingsRow(
                title = stringResource(R.string.settings_send_feedback),
                detail = stringResource(R.string.settings_send_feedback_detail),
                icon = Icons.Filled.Feedback,
                onClick = { open = true },
            )
        }
    }
    if (open) FeedbackSheet(onDismiss = { open = false })
}
