package io.github.hafijbge.meshdrop.engine.sync;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;

import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

public class PathSyncFolderTest {
    @Rule public TemporaryFolder tmp = new TemporaryFolder();

    @Test
    public void neverReachesAFileThroughALinkedFolderOutsideTheRoot() throws Exception {
        File outside = tmp.newFolder("private");
        Files.write(new File(outside, "secret.txt").toPath(), "secret".getBytes(StandardCharsets.UTF_8));
        File root = tmp.newFolder("sync");
        Files.write(new File(root, "ok.txt").toPath(), "ok".getBytes(StandardCharsets.UTF_8));
        Files.createSymbolicLink(new File(root, "docs").toPath(), outside.toPath());
        PathSyncFolder f = new PathSyncFolder(root.toPath());
        assertNull(f.stat("docs/secret.txt"));
        assertEquals(2, f.stat("ok.txt").size);
    }
}
