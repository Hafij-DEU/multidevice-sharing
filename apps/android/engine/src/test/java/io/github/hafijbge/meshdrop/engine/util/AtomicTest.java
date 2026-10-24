package io.github.hafijbge.meshdrop.engine.util;

import static org.junit.Assert.assertEquals;

import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.attribute.PosixFilePermissions;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

public class AtomicTest {
    @Rule public TemporaryFolder tmp = new TemporaryFolder();

    @Test
    public void writesOwnerOnlyAndReplaces() throws Exception {
        File f = new File(tmp.getRoot(), "sub/state.json");
        Atomic.write(f, "one".getBytes(StandardCharsets.UTF_8));
        Atomic.write(f, "two".getBytes(StandardCharsets.UTF_8));
        assertEquals("two", Files.readString(f.toPath()));
        assertEquals("rw-------", PosixFilePermissions.toString(Files.getPosixFilePermissions(f.toPath())));
        assertEquals(1, f.getParentFile().list().length); // no temp files left
    }
}
