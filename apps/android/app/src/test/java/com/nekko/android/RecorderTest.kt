package com.nekko.android

import com.nekko.android.voice.RecordingLatch
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class RecorderTest {
    private fun CountDownLatch.awaitReady() {
        assertTrue("Timed out waiting for recording worker", await(5, TimeUnit.SECONDS))
    }

    @Test
    fun `stop before IO startup is not lost and does not poison the next recording`() = runBlocking {
        val stopped = RecordingLatch()
        stopped.stop()
        var starts = 0
        stopped.withCancellation { active ->
            assertFalse(stopped.start(active) { starts++ })
        }
        val next = RecordingLatch()
        next.withCancellation { active ->
            assertTrue(next.start(active) { starts++ })
            assertFalse(next.stopped)
        }
        assertEquals(1, starts)
    }

    @Test
    fun `cancellation during allocation prevents startup and still cleans up`() = runBlocking {
        val session = RecordingLatch()
        val allocated = CountDownLatch(1)
        val finishAllocation = CountDownLatch(1)
        val starts = AtomicInteger()
        val releases = AtomicInteger()
        val job = launch(Dispatchers.Default) {
            session.withCancellation { active ->
                try {
                    allocated.countDown()
                    finishAllocation.awaitReady()
                    session.start(active) { starts.incrementAndGet() }
                } finally {
                    releases.incrementAndGet()
                }
            }
        }
        try {
            allocated.awaitReady()
            job.cancel()
            assertTrue(session.stopped)
        } finally {
            finishAllocation.countDown()
            job.join()
        }
        assertTrue(job.isCancelled)
        assertEquals(0, starts.get())
        assertEquals(1, releases.get())
    }

    @Test
    fun `stop during allocation prevents startup while returning normally with cleanup`() = runBlocking {
        val session = RecordingLatch()
        var starts = 0
        var releases = 0
        val samples = session.withCancellation { active ->
            try {
                // A stop arriving while AudioRecord or its PCM buffers are being allocated.
                session.stop()
                if (session.start(active) { starts++ }) shortArrayOf(1, 2) else ShortArray(0)
            } finally {
                releases++
            }
        }
        assertTrue(samples.isEmpty())
        assertEquals(0, starts)
        assertEquals(1, releases)
    }

    @Test
    fun `inactive coroutine cannot start even before its cancellation handler takes the lock`() {
        val session = RecordingLatch()
        var starts = 0
        assertFalse(session.start({ false }) { starts++ })
        assertEquals(0, starts)
    }

    @Test
    fun `stop serializes with a hardware start already in progress`() {
        val session = RecordingLatch()
        val starting = CountDownLatch(1)
        val finishStart = CountDownLatch(1)
        val stopping = CountDownLatch(1)
        val executor = Executors.newFixedThreadPool(2)
        val events = mutableListOf<String>()
        try {
            val start = executor.submit<Boolean> {
                session.start({ true }) {
                    starting.countDown()
                    finishStart.awaitReady()
                    events.add("started")
                }
            }
            starting.awaitReady()
            val stop = executor.submit {
                stopping.countDown()
                session.stop()
                events.add("stopped")
            }
            stopping.awaitReady()
            finishStart.countDown()
            assertTrue(start.get(5, TimeUnit.SECONDS))
            stop.get(5, TimeUnit.SECONDS)
            assertEquals(listOf("started", "stopped"), events)
            assertFalse(session.start({ true }) { error("Must not restart after stop") })
        } finally {
            finishStart.countDown()
            executor.shutdownNow()
            assertTrue(executor.awaitTermination(5, TimeUnit.SECONDS))
        }
    }

    @Test
    fun `normal recording starts returns samples and cleans up`() = runBlocking {
        val session = RecordingLatch()
        var starts = 0
        var releases = 0
        val samples = session.withCancellation { active ->
            try {
                assertTrue(session.start(active) { starts++ })
                val pcm = shortArrayOf(10, 20, 30)
                assertTrue(active())
                session.stop()
                pcm
            } finally {
                releases++
            }
        }
        assertEquals(listOf<Short>(10, 20, 30), samples.toList())
        assertEquals(1, starts)
        assertEquals(1, releases)
    }
}
