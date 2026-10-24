package io.github.hafijbge.meshdrop.engine.recv;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

import io.github.hafijbge.meshdrop.engine.proto.Chunks;
import io.github.hafijbge.meshdrop.engine.proto.Manifest;
import io.github.hafijbge.meshdrop.engine.proto.Offer;
import io.github.hafijbge.meshdrop.engine.proto.Sanitize;
import io.github.hafijbge.meshdrop.engine.util.Hex;
import java.io.File;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.security.MessageDigest;
import java.util.List;
import java.util.Map;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

/** Ports the cases of packages/core/test/inbox.test.ts named in the M4a plan, Task 5. */
public class InboxTest {
    @Rule public TemporaryFolder tmp = new TemporaryFolder();
    static final String A = "a".repeat(64), B = "b".repeat(64);

    static String sha(byte[] b) throws Exception {
        return Hex.of(MessageDigest.getInstance("SHA-256").digest(b));
    }

    static byte[] bytes(String s) {
        return s.getBytes(StandardCharsets.UTF_8);
    }

    static Manifest manifest(String sid, Object[][] files, String... dirs) throws Exception {
        Manifest m = new Manifest();
        m.sessionId = sid;
        m.from = A;
        m.to = B;
        m.createdAt = 1;
        for (int i = 0; i < files.length; i++) {
            byte[] d = (byte[]) files[i][1];
            m.files.add(new Manifest.FileEntry(i, (String) files[i][0], d.length, "application/octet-stream", sha(d)));
        }
        for (String d : dirs) m.dirs.add(d);
        return m;
    }

    File root;
    File state;

    Inbox inbox() throws Exception {
        if (root == null) {
            root = tmp.newFolder("inbox");
            state = tmp.newFolder("state");
        }
        return new Inbox(state, new DirectorySink(root));
    }

    static void writeAll(Inbox in, String sid, int fileId, byte[] data) throws Exception {
        for (long i = 0; i < Chunks.count(data.length); i++) {
            int from = (int) (i * Chunks.CHUNK_SIZE);
            int to = (int) Math.min(data.length, from + (long) Chunks.CHUNK_SIZE);
            in.writeChunk(sid, fileId, i, java.util.Arrays.copyOfRange(data, from, to));
        }
    }

    @Test
    public void storesASmallFileFinalizesWithVerifiedHashCleansUpPartial() throws Exception {
        Inbox in = inbox();
        String sid = Offer.newSessionId();
        byte[] d = bytes("hello");
        in.begin(sid, manifest(sid, new Object[][] {{"docs/a.txt", d}}), "ctx");
        in.writeChunk(sid, 0, 0, d);
        assertEquals("docs/a.txt", in.finalize(sid, 0));
        assertArrayEquals(d, Files.readAllBytes(new File(root, "docs/a.txt").toPath()));
        assertFalse(new File(state, sid + "/0.part").exists());
        assertEquals("ctx", in.load(sid).ctxExport);
    }

    @Test
    public void collisionExistingFileUntouchedTwoFinalizesGet1And2() throws Exception {
        Inbox in = inbox();
        Files.write(new File(root, "a.txt").toPath(), bytes("old"));
        for (int round = 1; round <= 2; round++) {
            String sid = Offer.newSessionId();
            byte[] d = bytes("new" + round);
            in.begin(sid, manifest(sid, new Object[][] {{"a.txt", d}}), "ctx");
            in.writeChunk(sid, 0, 0, d);
            assertEquals("a (" + round + ").txt", in.finalize(sid, 0));
        }
        assertEquals("old", Files.readString(new File(root, "a.txt").toPath()));
    }

    @Test
    public void twoFilesWithTheSamePathInOneManifestBothLand() throws Exception {
        Inbox in = inbox();
        String sid = Offer.newSessionId();
        in.begin(sid, manifest(sid, new Object[][] {{"x.bin", bytes("1")}, {"x.bin", bytes("2")}}), "ctx");
        in.writeChunk(sid, 0, 0, bytes("1"));
        in.writeChunk(sid, 1, 0, bytes("2"));
        assertEquals("x.bin", in.finalize(sid, 0));
        assertEquals("x (1).bin", in.finalize(sid, 1));
    }

    @Test
    public void resumeStateSurvivesRestartChunks0And2Of3() throws Exception {
        Inbox in = inbox();
        String sid = Offer.newSessionId();
        byte[] d = new byte[2 * Chunks.CHUNK_SIZE + 10];
        new java.util.Random(1).nextBytes(d);
        Manifest m = manifest(sid, new Object[][] {{"big.bin", d}});
        in.begin(sid, m, "ctx");
        in.writeChunk(sid, 0, 0, java.util.Arrays.copyOfRange(d, 0, Chunks.CHUNK_SIZE));
        in.writeChunk(sid, 0, 2, java.util.Arrays.copyOfRange(d, 2 * Chunks.CHUNK_SIZE, d.length));
        Inbox again = inbox();
        assertEquals(Map.of(0L, List.of(0L, 2L)), again.have(sid));
        again.writeChunk(sid, 0, 1, java.util.Arrays.copyOfRange(d, Chunks.CHUNK_SIZE, 2 * Chunks.CHUNK_SIZE));
        assertEquals("big.bin", again.finalize(sid, 0));
        assertArrayEquals(d, Files.readAllBytes(new File(root, "big.bin").toPath()));
    }

    @Test
    public void beginWithTheSameManifestKeepsProgressADifferentOneResetsIt() throws Exception {
        Inbox in = inbox();
        String sid = Offer.newSessionId();
        Manifest m = manifest(sid, new Object[][] {{"a", bytes("aa")}});
        in.begin(sid, m, "ctx");
        in.writeChunk(sid, 0, 0, bytes("aa"));
        in.begin(sid, m, "ctx2");
        assertEquals(Map.of(0L, List.of(0L)), in.have(sid));
        assertEquals("ctx2", in.load(sid).ctxExport);
        in.begin(sid, manifest(sid, new Object[][] {{"b", bytes("bb")}}), "ctx");
        assertEquals(Map.of(), in.have(sid));
    }

    @Test
    public void hashMismatchIntegrityErrorNoFinalFilePartialDiscarded() throws Exception {
        Inbox in = inbox();
        String sid = Offer.newSessionId();
        Manifest m = manifest(sid, new Object[][] {{"a.txt", bytes("good")}});
        in.begin(sid, m, "ctx");
        in.writeChunk(sid, 0, 0, bytes("evil"));
        assertThrows(Inbox.IntegrityError.class, () -> in.finalize(sid, 0));
        assertFalse(new File(root, "a.txt").exists());
        assertEquals(Map.of(), in.have(sid)); // the file restarts
    }

    @Test
    public void zeroByteFileAndEmptyDir() throws Exception {
        Inbox in = inbox();
        String sid = Offer.newSessionId();
        in.begin(sid, manifest(sid, new Object[][] {{"empty.txt", new byte[0]}}, "x/y/z", "con/nul"), "ctx");
        assertEquals("empty.txt", in.finalize(sid, 0));
        assertEquals(0, new File(root, "empty.txt").length());
        in.finalizeDirs(sid);
        assertTrue(new File(root, "x/y/z").isDirectory());
        assertTrue(new File(root, "_con/_nul").isDirectory());
    }

    @Test
    public void beginRejectsTheWholeManifestOnAnyUnsafePath() throws Exception {
        Inbox in = inbox();
        String sid = Offer.newSessionId();
        assertThrows(Sanitize.UnsafePath.class, () -> in.begin(sid, manifest(sid, new Object[][] {{"ok", bytes("1")}, {"../evil", bytes("2")}}), "ctx"));
        assertFalse(new File(state, sid).exists());
        assertThrows(Sanitize.UnsafePath.class, () -> in.begin("not-a-session", manifest(sid, new Object[][] {}), "ctx"));
    }

    @Test
    public void writeChunkRejectsUnknownSessionUnknownFileIdBadIndexWrongLength() throws Exception {
        Inbox in = inbox();
        String sid = Offer.newSessionId();
        in.begin(sid, manifest(sid, new Object[][] {{"a", bytes("abc")}}), "ctx");
        assertThrows(Inbox.UnknownSession.class, () -> in.writeChunk(Offer.newSessionId(), 0, 0, bytes("abc")));
        assertThrows(Inbox.ChunkRange.class, () -> in.writeChunk(sid, 7, 0, bytes("abc")));
        assertThrows(Inbox.ChunkRange.class, () -> in.writeChunk(sid, 0, 1, bytes("abc")));
        assertThrows(Inbox.ChunkRange.class, () -> in.writeChunk(sid, 0, 0, bytes("ab")));
        assertThrows(Inbox.Incomplete.class, () -> in.finalize(sid, 0));
        assertThrows(Inbox.ChunkRange.class, () -> in.finalize(sid, 9));
    }

    @Test
    public void aTornLastProgressLineIsIgnoredOnLoad() throws Exception {
        Inbox in = inbox();
        String sid = Offer.newSessionId();
        byte[] d = new byte[Chunks.CHUNK_SIZE * 2 + 1];
        in.begin(sid, manifest(sid, new Object[][] {{"f", d}}), "ctx");
        in.writeChunk(sid, 0, 0, new byte[Chunks.CHUNK_SIZE]);
        try (FileOutputStream out = new FileOutputStream(new File(state, sid + "/progress.log"), true)) {
            out.write(bytes("{\"c\":[0,"));
        }
        Inbox again = inbox(); // the app was killed mid-append
        assertEquals(Map.of(0L, List.of(0L)), again.have(sid));
        again.writeChunk(sid, 0, 1, new byte[Chunks.CHUNK_SIZE]);
        assertEquals(Map.of(0L, List.of(0L, 1L)), inbox().have(sid));
    }

    @Test
    public void pruneRemovesOldPartialSessionsAndStaleTombstones() throws Exception {
        Inbox in = inbox();
        String old = Offer.newSessionId(), fresh = Offer.newSessionId();
        in.begin(old, manifest(old, new Object[][] {{"a", bytes("1")}}), "ctx");
        in.begin(fresh, manifest(fresh, new Object[][] {{"b", bytes("2")}}), "ctx");
        long past = System.currentTimeMillis() - 31L * 24 * 3600 * 1000;
        for (File f : new File(state, old).listFiles()) assertTrue(f.setLastModified(past));
        assertTrue(new File(state, old).setLastModified(past));
        assertEquals(List.of(old), in.prune(Inbox.PARTIAL_TTL_MS));
        assertNull(in.load(old));
        assertTrue(in.load(fresh) != null);

        String done = Offer.newSessionId();
        in.markFinished(done, A, List.of("x.txt"));
        assertEquals(List.of("x.txt"), in.finished(done).files);
        assertEquals(A, in.finished(done).from);
        assertTrue(new File(state, ".finished/" + done + ".json").setLastModified(System.currentTimeMillis() - 8L * 24 * 3600 * 1000));
        in.prune(Inbox.PARTIAL_TTL_MS);
        assertNull(in.finished(done));
    }

    @Test
    public void completedListsFinalizedFileIds() throws Exception {
        Inbox in = inbox();
        String sid = Offer.newSessionId();
        in.begin(sid, manifest(sid, new Object[][] {{"a", bytes("1")}, {"b", bytes("2")}}), "ctx");
        in.writeChunk(sid, 1, 0, bytes("2"));
        in.finalize(sid, 1);
        assertEquals(List.of(1L), in.completed(sid));
        in.drop(sid);
        assertNull(in.load(sid));
    }

    @Test
    public void landsTheFolderUnderAUniqueNameAndLeavesTheFileAlone() throws Exception {
        Inbox in = inbox();
        Files.write(new File(root, "Photos").toPath(), bytes("i am a file"));
        String sid = Offer.newSessionId();
        byte[] d = bytes("jpeg");
        in.begin(sid, manifest(sid, new Object[][] {{"Photos/a.jpg", d}}, "Photos/empty"), "ctx");
        in.writeChunk(sid, 0, 0, d);
        assertEquals("Photos (1)/a.jpg", in.finalize(sid, 0));
        in.finalizeDirs(sid);
        assertTrue(new File(root, "Photos (1)/empty").isDirectory());
        assertEquals("i am a file", Files.readString(new File(root, "Photos").toPath()));
    }

    @Test
    public void keepsTheSameFolderAfterARestart() throws Exception {
        Inbox in = inbox();
        Files.write(new File(root, "Photos").toPath(), bytes("file"));
        String sid = Offer.newSessionId();
        Manifest m = manifest(sid, new Object[][] {{"Photos/a.jpg", bytes("one")}, {"Photos/b.jpg", bytes("two")}});
        in.begin(sid, m, "ctx");
        in.writeChunk(sid, 0, 0, bytes("one"));
        in.finalize(sid, 0);
        Inbox again = inbox();
        again.begin(sid, m, "ctx");
        again.writeChunk(sid, 1, 0, bytes("two"));
        assertEquals("Photos (1)/b.jpg", again.finalize(sid, 1));
    }

    @Test
    public void mergesIntoAnExistingDirectoryOfThatName() throws Exception {
        Inbox in = inbox();
        assertTrue(new File(root, "Photos").mkdir());
        Files.write(new File(root, "Photos/old.jpg").toPath(), bytes("old"));
        String sid = Offer.newSessionId();
        in.begin(sid, manifest(sid, new Object[][] {{"Photos/new.jpg", bytes("new")}}), "ctx");
        in.writeChunk(sid, 0, 0, bytes("new"));
        assertEquals("Photos/new.jpg", in.finalize(sid, 0));
    }

    @Test
    public void emojiNameCollisionReportsTheLandedName() throws Exception {
        Inbox in = inbox();
        Files.write(new File(root, "ü 😀.txt").toPath(), bytes("x"));
        String sid = Offer.newSessionId();
        in.begin(sid, manifest(sid, new Object[][] {{"ü 😀.txt", bytes("y")}}), "ctx");
        in.writeChunk(sid, 0, 0, bytes("y"));
        assertEquals("ü 😀 (1).txt", in.finalize(sid, 0));
    }

    @Test
    public void neverWritesThroughASymlinkedDirectory() throws Exception {
        Inbox in = inbox();
        File outside = tmp.newFolder("outside");
        Files.createSymbolicLink(new File(root, "docs").toPath(), outside.toPath());
        String sid = Offer.newSessionId();
        in.begin(sid, manifest(sid, new Object[][] {{"docs/a.txt", bytes("1")}}), "ctx");
        in.writeChunk(sid, 0, 0, bytes("1"));
        // The symlink is a non-directory at the top name: the folder lands as "docs (1)".
        assertEquals("docs (1)/a.txt", in.finalize(sid, 0));
        assertEquals(0, outside.list().length);
    }
}
