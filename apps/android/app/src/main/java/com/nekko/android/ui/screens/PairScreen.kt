package com.nekko.android.ui.screens

import androidx.compose.ui.res.stringResource
import com.nekko.android.R
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.ContentPaste
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.filled.QrCodeScanner
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalClipboard
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalResources
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.google.mlkit.common.MlKitException
import com.google.mlkit.vision.barcode.common.Barcode
import com.google.mlkit.vision.codescanner.GmsBarcodeScannerOptions
import com.google.mlkit.vision.codescanner.GmsBarcodeScanning
import com.nekko.android.data.ComputersRepository
import com.nekko.android.lock.LocalAppLock
import com.nekko.android.ui.components.NCard
import com.nekko.android.ui.theme.Nekko
import com.nekko.protocol.Pairing
import com.nekko.android.ui.components.Tone
import com.nekko.android.ui.components.Notice
import com.nekko.android.BuildConfig
import com.nekko.protocol.RelayHint
import com.nekko.protocol.Tailnet
import com.nekko.android.connection.TailnetStatus
import com.nekko.protocol.PairingLink
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch

/**
 * Pair with a computer: scan the QR from Settings → Remote access, or paste the
 * link. A `nekko-agent-pair:` link opened from outside the app lands here
 * pre-filled and asks before pairing.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun PairScreen(
    repo: ComputersRepository,
    initialLink: String?,
    onBack: () -> Unit,
    onPaired: () -> Unit,
) {
    val p = Nekko.palette
    val context = LocalContext.current
    val res = LocalResources.current
    val appLock = LocalAppLock.current
    val clipboard = LocalClipboard.current
    val scope = rememberCoroutineScope()
    val notALink = stringResource(R.string.chats_pair_not_a_link)
    var text by rememberSaveable { mutableStateOf("") }
    var error by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf<PairingLink?>(null) }
    // A link from outside the app is only a proposal until the user confirms it.
    var proposed by remember(initialLink) {
        mutableStateOf(initialLink?.let { Pairing.parse(it) })
    }
    LaunchedEffect(initialLink) {
        // An unreadable link from outside: show it so the user can see what came in.
        if (initialLink != null && Pairing.parse(initialLink) == null) {
            text = initialLink
            error = notALink
        }
    }

    val commit: (String) -> Unit = commit@{ raw ->
        if (busy != null) return@commit
        val link = Pairing.parse(raw)
        if (link == null) {
            error = notALink
            return@commit
        }
        error = null
        proposed = null
        busy = link
        scope.launch {
            try {
                repo.pair(link)
                onPaired()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                busy = null
                error = e.message?.takeIf { it.isNotBlank() } ?: res.getString(R.string.chats_pair_failed)
            }
        }
    }

    val scan = {
        error = null
        val options = GmsBarcodeScannerOptions.Builder()
            .setBarcodeFormats(Barcode.FORMAT_QR_CODE)
            .enableAutoZoom()
            .build()
        // The scanner is another app's screen: coming back from it is not a new visit.
        appLock?.expectReturn()
        GmsBarcodeScanning.getClient(context, options).startScan()
            .addOnCompleteListener { appLock?.returned() }
            .addOnSuccessListener { code ->
                val raw = code.rawValue.orEmpty()
                text = raw
                commit(raw)
            }
            .addOnFailureListener { e ->
                error = if (e is MlKitException && e.errorCode == MlKitException.UNAVAILABLE) {
                    res.getString(R.string.chats_pair_scanner_downloading)
                } else {
                    res.getString(R.string.chats_pair_scanner_failed)
                }
            }
        Unit
    }

    Scaffold(
        containerColor = p.paper,
        topBar = {
            TopAppBar(
                title = { Text(stringResource(R.string.chats_pair_title)) },
                colors = TopAppBarDefaults.topAppBarColors(containerColor = p.paper),
                navigationIcon = {
                    IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = stringResource(R.string.chats_back)) }
                },
            )
        },
    ) { padding ->
        Column(
            Modifier
                .fillMaxSize()
                .padding(padding)
                .imePadding()
                .verticalScroll(rememberScrollState())
                .padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            val pending = busy
            val offer = proposed
            when {
                pending != null -> NCard {
                    Column(
                        Modifier.fillMaxWidth().padding(vertical = 16.dp),
                        horizontalAlignment = Alignment.CenterHorizontally,
                        verticalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        Icon(Icons.Filled.Lock, contentDescription = null, tint = p.accent, modifier = Modifier.size(28.dp))
                        Text(stringResource(R.string.chats_pairing_securely), style = MaterialTheme.typography.titleMedium, color = p.ink)
                        Text(
                            stringResource(R.string.chats_pairing_deriving, Pairing.relayHost(pending.relayUrl)),
                            style = MaterialTheme.typography.bodyMedium,
                            color = p.inkSoft,
                            textAlign = TextAlign.Center,
                        )
                        CircularProgressIndicator(color = p.accent, modifier = Modifier.size(24.dp))
                    }
                }
                offer != null -> NCard {
                    Text(stringResource(R.string.chats_pair_confirm_title), style = MaterialTheme.typography.titleMedium, color = p.ink)
                    Text(
                        stringResource(R.string.chats_pair_confirm_body, Pairing.relayHost(offer.relayUrl)),
                        style = MaterialTheme.typography.bodyMedium,
                        color = p.inkSoft,
                    )
                    // Say now if this relay can't work from a phone, rather than spinning after pairing.
                    val yourComputer = stringResource(R.string.chats_your_computer)
                    RelayHint.problem(offer.relayUrl, BuildConfig.DEBUG)?.let { problem ->
                        Notice(RelayHint.message(problem, yourComputer), Tone.DANGER)
                    } ?: Tailnet.hint(offer.relayUrl, TailnetStatus.phoneOnTailnet(), yourComputer)?.let { line ->
                        // Tailscale first: pairing over the tailnet needs it on here too.
                        Notice(line, Tone.WARNING)
                    }
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        OutlinedButton(
                            onClick = { proposed = null },
                            modifier = Modifier.weight(1f).heightIn(min = 48.dp),
                        ) { Text(stringResource(R.string.chats_cancel)) }
                        Button(
                            onClick = { commit(initialLink.orEmpty()) },
                            modifier = Modifier.weight(1f).heightIn(min = 48.dp),
                        ) { Text(stringResource(R.string.chats_pair)) }
                    }
                }
                else -> {
                    Button(onClick = scan, modifier = Modifier.fillMaxWidth().heightIn(min = 56.dp)) {
                        Icon(Icons.Filled.QrCodeScanner, contentDescription = null, modifier = Modifier.size(20.dp))
                        Spacer(Modifier.size(8.dp))
                        Text(stringResource(R.string.chats_scan_qr))
                    }
                    Text(
                        stringResource(R.string.chats_pair_instructions),
                        style = MaterialTheme.typography.bodyMedium,
                        color = p.inkSoft,
                    )
                    OutlinedTextField(
                        value = text,
                        onValueChange = {
                            text = it
                            error = null
                        },
                        label = { Text(stringResource(R.string.chats_pairing_link)) },
                        placeholder = { Text("nekko-agent-pair:?relay=…") },
                        textStyle = Nekko.mono.copy(color = p.ink),
                        isError = error != null,
                        minLines = 3,
                        keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.None, autoCorrectEnabled = false),
                        modifier = Modifier.fillMaxWidth(),
                    )
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        OutlinedButton(
                            onClick = {
                                scope.launch {
                                    val v = clipboard.getClipEntry()?.clipData?.takeIf { it.itemCount > 0 }
                                        ?.getItemAt(0)?.coerceToText(context)?.toString().orEmpty()
                                    text = v
                                    error = null
                                    if (Pairing.parse(v) != null) commit(v)
                                }
                            },
                            modifier = Modifier.heightIn(min = 48.dp),
                        ) {
                            Icon(Icons.Filled.ContentPaste, contentDescription = null, modifier = Modifier.size(18.dp))
                            Spacer(Modifier.size(8.dp))
                            Text(stringResource(R.string.chats_paste))
                        }
                        Button(
                            onClick = { commit(text) },
                            enabled = text.isNotBlank(),
                            modifier = Modifier.weight(1f).heightIn(min = 48.dp),
                        ) { Text(stringResource(R.string.chats_pair)) }
                    }
                    NearbyCard()
                }
            }
            error?.let { Text(it, style = MaterialTheme.typography.bodyMedium, color = p.danger) }
            if (busy == null) {
                Text(
                    stringResource(R.string.chats_pair_link_note),
                    style = MaterialTheme.typography.bodySmall,
                    color = p.inkFaint,
                )
            }
        }
    }
}
