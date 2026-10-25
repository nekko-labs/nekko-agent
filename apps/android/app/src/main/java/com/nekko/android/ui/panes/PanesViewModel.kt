package com.nekko.android.ui.panes

import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelStore
import androidx.lifecycle.ViewModelStoreOwner
import com.nekko.android.data.PaneLayouts
import com.nekko.protocol.PaneLayout
import com.nekko.protocol.PaneMode
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * The open phone's two panes: the [PaneLayout] for the active computer, restored
 * from and saved to [PaneLayouts] on every change, the posture it was last laid out
 * for, and the one-time *Chat + Chat* tip. Activity-scoped, so a chat opened from a
 * link or from the closed phone lands in the same panes.
 */
class PanesViewModel(private val store: PaneLayouts) : ViewModel() {
    private val _layout = MutableStateFlow(PaneLayout.DEFAULT)
    val layout: StateFlow<PaneLayout> = _layout.asStateFlow()

    private val _tip = MutableStateFlow<String?>(null)

    /** The running chat the tip offers to keep beside the one just opened; null when no tip shows. */
    val tip: StateFlow<String?> = _tip.asStateFlow()

    private var computerId: String? = null
    private var mode: PaneMode? = null

    /** The last two-pane or tabletop mode, so closing and reopening the phone restores from it. */
    private var lastOpen: PaneMode? = null

    /** One [ViewModelStore] per pane view, so each chat pane keeps its own ChatViewModel while it is on screen. */
    val stores = PaneStores()

    /** The computer changed (or the app started): its own last arrangement. */
    fun attach(id: String?) {
        if (id == computerId) return
        computerId = id
        _tip.value = null
        val restored = id?.let(store::get) ?: PaneLayout.DEFAULT
        _layout.value = lastOpen?.let { restored.forMode(it, null) } ?: restored
    }

    /**
     * The posture changed: rotate, stack, or go to tabletop ([PaneLayout.forMode]).
     * Returns the mode before, null on the first call (this view model survives the
     * activity being recreated, so the new one still sees where it came from).
     */
    fun onMode(next: PaneMode): PaneMode? {
        val was = mode
        if (next == was) return was
        mode = next
        if (next == PaneMode.ONE) return was
        set(_layout.value.forMode(next, lastOpen))
        lastOpen = next
        return was
    }

    /**
     * Any pane change ([PaneLayout.swap], [PaneLayout.open], …), with the current mode's
     * rules applied after it. [running] are the chats working or waiting now, for the tip.
     */
    fun update(running: Set<String> = emptySet(), change: (PaneLayout) -> PaneLayout) {
        val before = _layout.value
        val after = change(before).let { l -> mode?.let(l::normalized) ?: l }
        // A touch in the pane that already has the keyboard changes nothing: nothing to save.
        if (after == before) return
        if (!store.tipShown) {
            before.tipFor(after, running)?.let { keep ->
                _tip.value = keep
                store.tipShown = true
            }
        }
        set(after)
    }

    /** The tip's *Chat + Chat*: the list's pane shows the running chat beside the new one. */
    fun takeTip() {
        val keep = _tip.value ?: return
        _tip.value = null
        update { it.chatBeside(keep) }
    }

    fun dismissTip() {
        _tip.value = null
    }

    private fun set(l: PaneLayout) {
        _layout.value = l
        computerId?.let { store.set(it, l) }
    }

    override fun onCleared() {
        stores.clear()
    }
}

/**
 * A [ViewModelStore] per pane view ([com.nekko.protocol.PaneContent.key]). A view
 * that leaves both panes has its store cleared, so a replaced chat stops listening
 * to the computer's events; one that only moves (Swap, rotation) keeps it.
 */
class PaneStores {
    private val owners = HashMap<String, ViewModelStoreOwner>()

    fun owner(key: String): ViewModelStoreOwner = synchronized(owners) {
        owners.getOrPut(key) {
            val store = ViewModelStore()
            object : ViewModelStoreOwner {
                override val viewModelStore = store
            }
        }
    }

    /** Clears every store but [keys]'. */
    fun keepOnly(keys: Set<String>) {
        val gone = synchronized(owners) {
            val drop = owners.keys.filter { it !in keys }
            drop.mapNotNull { owners.remove(it) }
        }
        gone.forEach { it.viewModelStore.clear() }
    }

    fun clear() = keepOnly(emptySet())
}
