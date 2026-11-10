package com.nekko.android.ui.chat

import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import com.nekko.android.R
import com.nekko.android.ui.theme.Nekko
import com.nekko.protocol.ImageChatModel
import com.nekko.protocol.ImageChatParams
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch

/** Shared by New chat and the image settings sheet; never offers a text/vision model. */
@Composable
fun ImageChatEditor(
    initial: ImageChatParams = ImageChatParams(),
    enabled: Boolean,
    loadModels: suspend () -> List<ImageChatModel>,
    actionLabel: String,
    onSave: suspend (ImageChatParams) -> Unit,
) {
    val p = Nekko.palette
    val scope = rememberCoroutineScope()
    var models by remember { mutableStateOf<List<ImageChatModel>>(emptyList()) }
    var model by remember { mutableStateOf(initial.modelId) }
    var width by remember { mutableStateOf(initial.width.display()) }
    var height by remember { mutableStateOf(initial.height.display()) }
    var steps by remember { mutableStateOf(initial.steps.display()) }
    var cfg by remember { mutableStateOf(initial.cfgScale.display()) }
    var seed by remember { mutableStateOf(initial.seed.display()) }
    var busy by remember { mutableStateOf(false) }
    var loading by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var retry by remember { mutableStateOf(0) }
    LaunchedEffect(enabled, retry) {
        models = emptyList()
        if (enabled) {
            loading = true
            try { models = loadModels(); error = null }
            catch (e: CancellationException) { throw e }
            catch (e: Exception) { error = e.message }
            finally { loading = false }
        }
    }
    fun number(s: String) = s.toDoubleOrNull() ?: Double.NaN
    val params = ImageChatParams(model, number(width), number(height), number(steps), number(cfg), number(seed))
    Column(Modifier.fillMaxWidth().testTag("image.editor"), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(stringResource(R.string.image_model), style = MaterialTheme.typography.titleSmall, color = p.ink)
        Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            models.forEach { m ->
                FilterChip(selected = model == m.id, onClick = { model = m.id }, enabled = enabled && !busy,
                    label = { Text(listOfNotNull(m.name, m.format, m.state).joinToString(" · ")) }, modifier = Modifier.testTag("image.model.${m.id}"))
            }
        }
        if (loading) Text(stringResource(R.string.image_models_loading), color = p.inkSoft)
        if (enabled && !loading && models.isEmpty()) Text(stringResource(R.string.image_no_models), color = p.inkSoft)
        if (enabled) TextButton(onClick = { retry++ }, enabled = !busy && !loading) { Text(stringResource(R.string.image_retry_models)) }
        if (model != null && models.none { it.id == model }) Text(stringResource(R.string.image_model_missing, model.orEmpty()), color = p.warning)
        // Separate fields stay usable on a folded phone and in either unfolded pane; no fixed width.
        ImageNumber(width, { width = it }, R.string.image_width, enabled && !busy, "image.width")
        ImageNumber(height, { height = it }, R.string.image_height, enabled && !busy, "image.height")
        ImageNumber(steps, { steps = it }, R.string.image_steps, enabled && !busy, "image.steps")
        ImageNumber(cfg, { cfg = it }, R.string.image_cfg, enabled && !busy, "image.cfg")
        ImageNumber(seed, { seed = it }, R.string.image_seed, enabled && !busy, "image.seed")
        if (!params.valid) Text(stringResource(R.string.image_integer_settings), color = p.warning, style = MaterialTheme.typography.bodySmall)
        error?.let { Text(it, color = p.danger, style = MaterialTheme.typography.bodySmall) }
        Button(onClick = {
            busy = true; error = null
            scope.launch {
                try { onSave(params) }
                catch (e: CancellationException) { throw e }
                catch (e: Exception) { error = e.message }
                finally { busy = false }
            }
        }, enabled = enabled && !busy && params.valid && models.any { it.id == model }, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp).testTag("image.save")) {
            Text(if (busy) stringResource(R.string.image_working) else actionLabel)
        }
    }
}

private fun Double.display(): String = if (isFinite() && this % 1 == 0.0) toLong().toString() else toString()

@Composable
private fun ImageNumber(value: String, change: (String) -> Unit, label: Int, enabled: Boolean, tag: String) {
    OutlinedTextField(value, change, label = { Text(stringResource(label)) }, enabled = enabled, singleLine = true,
        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number), modifier = Modifier.fillMaxWidth().testTag(tag))
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ImageChatSettingsSheet(initial: ImageChatParams, enabled: Boolean, loadModels: suspend () -> List<ImageChatModel>, onSave: suspend (ImageChatParams) -> Unit, onDismiss: () -> Unit) {
    ModalBottomSheet(onDismissRequest = onDismiss, containerColor = Nekko.palette.paper) {
        Column(Modifier.padding(horizontal = 16.dp).padding(bottom = 24.dp).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Text(stringResource(R.string.image_settings), style = MaterialTheme.typography.titleMedium, color = Nekko.palette.ink)
            ImageChatEditor(initial, enabled, loadModels, stringResource(R.string.image_save_settings)) { onSave(it); onDismiss() }
        }
    }
}
