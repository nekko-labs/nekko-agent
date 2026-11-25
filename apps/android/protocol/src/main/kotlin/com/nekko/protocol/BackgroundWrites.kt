package com.nekko.protocol

import java.util.concurrent.Callable
import java.util.concurrent.ScheduledThreadPoolExecutor
import java.util.concurrent.TimeUnit

/**
 * One background thread that runs small file jobs in the order they were asked for, so a removal
 * never overtakes the write before it (the iPhone's `BackgroundIO`). The app's saved chats and
 * chat lists use it so the main thread only files a value away; encoding and writing happen here.
 */
class BackgroundIO(name: String = "nekko-background-io") {
    private val executor = ScheduledThreadPoolExecutor(1) { r -> Thread(r, name).apply { isDaemon = true } }.apply {
        removeOnCancelPolicy = true
    }

    /** Run [work] after everything asked for before it. */
    fun run(work: () -> Unit) {
        executor.execute { runCatching(work) }
    }

    /** Run [work] after [delayMs] (and after what was asked for before it, if that is later). */
    fun runAfter(delayMs: Long, work: () -> Unit) {
        executor.schedule({ runCatching(work) }, delayMs, TimeUnit.MILLISECONDS)
    }

    /** Returns when everything asked for before this call with [run] has run (blocks the caller: for a read that must see those writes, and for tests). */
    fun waitUntilIdle() {
        executor.submit(Callable { }).get()
    }
}

/**
 * Saves that arrive in a burst become one write of the newest value. The caller only files the value
 * away ([submit]); [write] runs on [io] about [delayMs] later, newest value per key (the first submit
 * of a burst sets the time, so a long burst still writes steadily). With a null [io] every submit
 * writes at once on the caller's thread (tests, previews).
 */
class CoalescedWriter<V>(
    private val io: BackgroundIO?,
    private val delayMs: Long = 250,
    private val write: (key: String, value: V) -> Unit,
) {
    private val lock = Any()
    private val pending = LinkedHashMap<String, V>()
    private var timer = false

    /** Writes handed to [write] since this writer was made. */
    @Volatile var written = 0
        private set

    /** The value waiting to be written for [key], if any: what a read must prefer to the file. */
    fun pending(key: String): V? = synchronized(lock) { pending[key] }

    val hasPending: Boolean get() = synchronized(lock) { pending.isNotEmpty() }

    fun submit(key: String, value: V) {
        if (io == null) {
            written++
            write(key, value)
            return
        }
        val schedule = synchronized(lock) {
            pending[key] = value
            (!timer).also { timer = true }
        }
        if (schedule) io.runAfter(delayMs) { drain() }
    }

    /** Hand everything waiting to the queue now (the app is going to the background). */
    fun flushNow() {
        val io = io ?: return
        val batch = take()
        if (batch.isNotEmpty()) io.run { batch.forEach(::emit) }
    }

    /** Forget what waits for [key] (the thing it would write is gone). */
    fun cancel(key: String) {
        synchronized(lock) { pending.remove(key) }
    }

    fun cancelAll() {
        synchronized(lock) { pending.clear() }
    }

    /** Runs on [io]: write what is waiting now. */
    private fun drain() {
        take().forEach(::emit)
    }

    private fun take(): List<Pair<String, V>> = synchronized(lock) {
        timer = false
        pending.entries.map { it.key to it.value }.also { pending.clear() }
    }

    private fun emit(e: Pair<String, V>) {
        written++
        write(e.first, e.second)
    }
}
