package com.nekko.android.ui.security

import com.nekko.android.R
import androidx.compose.ui.res.stringResource
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import com.nekko.android.ui.theme.Nekko

/**
 * The owner's note on every hardware-key surface (Settings → Security and the
 * step-up sheet), word for word: the curly apostrophe and the 🙏 stay.
 */
const val UNTESTED_HARDWARE_KEY_NOTE =
    "The Devs don’t have a hardware security key to test this one, so we tried our best without one! If you see any issues, please let us know 🙏"

/** Where "let us know" goes: the public issue tracker. */
const val UNTESTED_NOTE_ISSUES_URL = "https://github.com/nekko-labs/nekko-agent/issues/new"


/**
 * [UNTESTED_HARDWARE_KEY_NOTE] as a small caption: not a dialog, never in the
 * way. A Text with one linked phrase is a small tap target on a phone, so the
 * whole caption opens the issue tracker and "let us know" is underlined to say so.
 */
@Composable
fun HardwareKeyNote(modifier: Modifier = Modifier) {
    val p = Nekko.palette
    val uri = LocalUriHandler.current
    // The note in the phone's language ([UNTESTED_HARDWARE_KEY_NOTE] in English), and the part of it that reads as a link.
    val note = stringResource(R.string.settings_hw_note)
    val link = stringResource(R.string.settings_hw_note_link)
    val text = remember(p.accent, note, link) {
        buildAnnotatedString {
            val at = note.indexOf(link)
            if (at < 0) {
                append(note)
            } else {
                append(note.substring(0, at))
                withStyle(SpanStyle(color = p.accent, textDecoration = TextDecoration.Underline)) { append(link) }
                append(note.substring(at + link.length))
            }
        }
    }
    Text(
        text,
        style = MaterialTheme.typography.bodySmall,
        color = p.inkFaint,
        modifier = modifier
            .fillMaxWidth()
            .clickable(role = Role.Button, onClickLabel = stringResource(R.string.settings_report_issue)) {
                runCatching { uri.openUri(UNTESTED_NOTE_ISSUES_URL) }
            }
            .padding(horizontal = 4.dp, vertical = 8.dp),
    )
}
