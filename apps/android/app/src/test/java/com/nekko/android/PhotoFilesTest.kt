package com.nekko.android

import com.nekko.android.ui.chat.PhotoFiles
import org.junit.Assert.assertEquals
import org.junit.Test

/** #2111: a photo leaves the viewer as its own bytes and type, never re-encoded. */
class PhotoFilesTest {
    @Test fun `the type and file name come from the data URL`() {
        assertEquals("image/png", PhotoFiles.mime("data:image/png;base64,iVBOR"))
        assertEquals("image/webp", PhotoFiles.mime("data:image/webp;base64,UklG"))
        assertEquals("a URL that doesn't say is JPEG", "image/jpeg", PhotoFiles.mime("data:;base64,/9j/"))
        assertEquals("png", PhotoFiles.extension("image/png"))
        assertEquals("jpg", PhotoFiles.extension("image/jpeg"))
        assertEquals("heic", PhotoFiles.extension("image/heic"))
    }
}
