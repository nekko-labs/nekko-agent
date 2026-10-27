package com.nekko.android.terminal

import com.nekko.android.data.ComputersRepository
import com.nekko.protocol.TerminalEvent
import com.nekko.protocol.TerminalRequest
import kotlinx.coroutines.flow.Flow
import kotlinx.serialization.json.JsonElement

/** The active computer as the terminal screens' backend: reads plain, opening signed (AN-32), output from its events. */
class RepoTerminalBackend(private val repo: ComputersRepository) : TerminalBackend {
    override suspend fun read(r: TerminalRequest): JsonElement = repo.caller.call(r.channel, *r.args.toTypedArray())
    override suspend fun change(r: TerminalRequest): JsonElement = repo.callChange(r.channel, r.args)
    override val events: Flow<TerminalEvent> get() = repo.terminalEvents
    override val computerName: String get() = repo.state.value.active?.name ?: "your computer"
}
