package io.github.hafijbge.meshdrop.engine.sync;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import io.github.hafijbge.meshdrop.engine.Engine;
import io.github.hafijbge.meshdrop.engine.EngineConfig;
import io.github.hafijbge.meshdrop.engine.identity.PlainKeyVault;
import io.github.hafijbge.meshdrop.engine.recv.DirectorySink;
import io.github.hafijbge.meshdrop.engine.testutil.Node;
import io.github.hafijbge.meshdrop.engine.testutil.NodeListen;
import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.attribute.FileTime;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import org.junit.After;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

public class SyncTest {
    @Rule public TemporaryFolder tmp = new TemporaryFolder();
    private final List<Engine> engines = new ArrayList<>();

    @After
    public void stop() {
        for (Engine e : engines) e.stop();
    }

    private Engine engine(String alias) throws Exception {
        File home = tmp.newFolder();
        EngineConfig c = new EngineConfig(home, new PlainKeyVault(), new DirectorySink(new File(home, "inbox")));
        c.port = 0;
        c.guestPort = -1;
        c.discovery = false;
        c.alias = alias;
        Engine e = Engine.create(c);
        e.start();
        engines.add(e);
        return e;
    }

    private static void write(File dir, String rel, String text) throws Exception {
        File f = new File(dir, rel);
        f.getParentFile().mkdirs();
        Files.write(f.toPath(), text.getBytes(StandardCharsets.UTF_8));
    }

    private static String read(File dir, String rel) throws Exception {
        return new String(Files.readAllBytes(new File(dir, rel).toPath()), StandardCharsets.UTF_8);
    }

    private static void until(java.util.function.BooleanSupplier c, long ms) throws InterruptedException {
        long end = System.currentTimeMillis() + ms;
        while (!c.getAsBoolean()) {
            if (System.currentTimeMillis() > end) throw new AssertionError("condition not met in time");
            Thread.sleep(25);
        }
    }

    @Test
    public void mergeTable() {
        assertEquals(SyncMerge.Kind.AGREE, SyncMerge.decide("h1", 0, "h1", 0, null, "aa", "bb").kind);
        assertEquals(SyncMerge.Kind.TAKE, SyncMerge.decide(null, 0, "h1", 0, null, "aa", "bb").kind);
        SyncMerge.Decision del = SyncMerge.decide("h0", 0, null, 0, "h0", "aa", "bb");
        assertEquals(SyncMerge.Kind.TAKE, del.kind);
        assertNull(del.base);
        assertEquals(SyncMerge.Kind.KEEP, SyncMerge.decide("h1", 0, "h0", 0, "h0", "aa", "bb").kind);
        assertEquals(SyncMerge.Kind.TAKE, SyncMerge.decide(null, 0, "h2", 0, "h0", "aa", "bb").kind);
        assertEquals(SyncMerge.Kind.KEEP, SyncMerge.decide("h1", 0, null, 0, "h0", "aa", "bb").kind);
        assertEquals(SyncMerge.Kind.CONFLICT_TAKE, SyncMerge.decide("h1", 100, "h2", 200, "h0", "aa", "bb").kind);
        assertEquals(SyncMerge.Kind.KEEP, SyncMerge.decide("h1", 300, "h2", 200, "h0", "aa", "bb").kind);
        assertEquals(SyncMerge.Kind.CONFLICT_TAKE, SyncMerge.decide("h1", 100, "h2", 100, null, "aa", "bb").kind);
        assertEquals(SyncMerge.Kind.KEEP, SyncMerge.decide("h1", 100, "h2", 100, null, "bb", "aa").kind);
        assertTrue(SyncIgnore.ignored(".meshdrop-trash/x"));
        assertTrue(SyncIgnore.ignored("a/b.part"));
        assertFalse(SyncIgnore.ignored("photo.jpg"));
    }

    @Test
    public void twoPhonesSyncEditsDeletesAndConflicts() throws Exception {
        Engine a = engine("alpha");
        Engine b = engine("beta");
        a.pairManual("127.0.0.1", b.port(), "beta");
        b.pairManual("127.0.0.1", a.port(), "alpha");
        File fa = tmp.newFolder("A");
        File fb = tmp.newFolder("B");
        a.syncPut("Shared", fa.getPath(), Collections.singletonList(b.identity().deviceId()), null);
        b.syncPut("Shared", fb.getPath(), Collections.singletonList(a.identity().deviceId()), null);
        write(fa, "docs/x.txt", "one");
        write(fa, "skip.part", "temp");
        b.syncNow(null);
        a.syncNow(null);
        assertEquals("one", read(fb, "docs/x.txt"));
        assertFalse(new File(fb, "skip.part").exists());

        write(fb, "docs/x.txt", "two");
        a.syncNow(null);
        assertEquals("two", read(fa, "docs/x.txt"));
        assertEquals("one", read(new File(fa, "Deleted/docs"), "x.txt")); // the replaced version, path kept
        b.syncNow(null); // B learns A has it (A's poke does this by itself)

        new File(fa, "docs/x.txt").delete();
        b.syncNow(null);
        assertFalse(new File(fb, "docs/x.txt").exists());
        assertEquals("two", read(new File(fb, "Deleted/docs"), "x.txt"));
        a.syncNow(null);
        assertFalse(new File(fa, "Deleted/docs/x.txt").exists() && read(new File(fa, "Deleted/docs"), "x.txt").equals("two")); // B's Deleted does not travel

        write(fa, "n.txt", "base");
        b.syncNow(null);
        a.syncNow(null);
        write(fa, "n.txt", "from A");
        write(fb, "n.txt", "from B");
        long t = System.currentTimeMillis();
        Files.setLastModifiedTime(new File(fa, "n.txt").toPath(), FileTime.fromMillis(t + 60_000));
        Files.setLastModifiedTime(new File(fb, "n.txt").toPath(), FileTime.fromMillis(t));
        b.syncNow(null);
        a.syncNow(null);
        assertEquals("from A", read(fb, "n.txt"));
        String[] copies = fa.list((d, n) -> n.startsWith("n (conflict from alpha"));
        assertEquals(Arrays.toString(fa.list()), 1, copies.length);
        assertEquals("from B", read(fa, copies[0]));
    }

    @Test
    public void syncsBothWaysWithTheNodeEngine() throws Exception {
        Engine e = engine("phone");
        File pcHome = tmp.newFolder();
        NodeListen pc = NodeListen.start(pcHome);
        File nf = tmp.newFolder("pc-sync");
        File jf = tmp.newFolder("phone-sync");
        try {
            e.pairManual("127.0.0.1", pc.port, "pc");
            Node.Result r = Node.run("pair", "127.0.0.1:" + e.port(), "phone", "--home", pc.home.getPath());
            assertEquals(r.out, 0, r.code);
            int port = pc.port;
            pc.close();
            new File(pcHome, "sync").mkdirs();
            Files.write(new File(pcHome, "sync/config.json").toPath(),
                    ("{\"folder\":" + io.github.hafijbge.meshdrop.engine.util.Json.stringify(nf.getPath()) + ",\"partners\":[\"" + e.identity().deviceId() + "\"]}").getBytes(StandardCharsets.UTF_8));
            write(nf, "from pc/ü 😀.txt", "pc");
            pc = NodeListen.start(pcHome, port); // knows the phone's address from the pairing
            e.syncPut("pc-sync", jf.getPath(), Collections.singletonList(pc.deviceId), null); // the PC's 0.3.0-style config: its folder is named after its directory
            e.syncNow(null);
            assertEquals("pc", read(jf, "from pc/ü 😀.txt"));
            write(jf, "from phone.txt", "phone");
            e.syncNow(null); // a local change: the phone pokes the PC, which pulls
            until(() -> new File(nf, "from phone.txt").exists(), 20_000);
            assertEquals("phone", read(nf, "from phone.txt"));
        } finally {
            pc.close();
        }
    }

    @Test
    public void severalFoldersSyncByNameEachWithItsOwnPartners() throws Exception {
        Engine a = engine("alpha");
        Engine b = engine("beta");
        a.pairManual("127.0.0.1", b.port(), "beta");
        b.pairManual("127.0.0.1", a.port(), "alpha");
        String ia = a.identity().deviceId(), ib = b.identity().deviceId();
        File docsA = tmp.newFolder("Documents"), photosA = tmp.newFolder("Photos"), docsB = tmp.newFolder("Docs on tablet");
        a.syncPut("Docs", docsA.getPath(), Collections.singletonList(ib), null);
        a.syncPut(null, photosA.getPath(), Collections.singletonList(ib), null);
        b.syncPut("Docs", docsB.getPath(), Collections.singletonList(ia), null);
        assertEquals("Photos", a.syncFolders().get(1).name);
        write(docsA, "cv.txt", "cv");
        write(photosA, "cat.jpg", "meow");
        b.syncNow(null);
        assertEquals("cv", read(docsB, "cv.txt"));
        assertFalse(new File(docsB, "cat.jpg").exists());
        a.syncNow("Photos");
        @SuppressWarnings("unchecked")
        Map<String, Object> photos = (Map<String, Object>) ((List<Object>) a.syncStatus().get("folders")).get(1);
        @SuppressWarnings("unchecked")
        Map<String, Object> last = (Map<String, Object>) ((Map<String, Object>) ((List<Object>) photos.get("partners")).get(0)).get("last");
        assertTrue(String.valueOf(last.get("error")), String.valueOf(last.get("error")).contains("404"));
        b.syncPut("Paperwork", docsB.getPath(), Collections.singletonList(ia), "Docs"); // renamed: no longer matches A's "Docs"
        write(docsA, "new.txt", "n");
        b.syncNow(null);
        assertFalse(new File(docsB, "new.txt").exists());
        b.syncRemove("Paperwork");
        assertTrue(b.syncFolders().isEmpty());
        assertEquals("cv", read(docsB, "cv.txt"));
    }

    @Test
    public void aPhotoBackupLandsInThePcsBackupFolder() throws Exception {
        Engine e = engine("Pixel");
        try (NodeListen pc = NodeListen.start(tmp.newFolder())) {
            e.pairManual("127.0.0.1", pc.port, "pc");
            Node.Result r = Node.run("pair", "127.0.0.1:" + e.port(), "Pixel", "--home", pc.home.getPath());
            assertEquals(r.out, 0, r.code);
            File img = new File(tmp.getRoot(), "IMG_2001.jpg");
            Files.write(img.toPath(), "jpeg".getBytes(StandardCharsets.UTF_8));
            List<io.github.hafijbge.meshdrop.engine.send.SendResult> rs = e.send(Collections.singletonList(pc.deviceId),
                    Collections.singletonList(io.github.hafijbge.meshdrop.engine.send.SendItem.file(io.github.hafijbge.meshdrop.engine.send.PathSource.file(img.toPath()))),
                    null, true).get(60, java.util.concurrent.TimeUnit.SECONDS);
            assertEquals("done", rs.get(0).status);
            File landed = new File(pc.home, "backup/Pixel/IMG_2001.jpg");
            until(landed::exists, 10_000);
            assertEquals("jpeg", read(landed.getParentFile(), "IMG_2001.jpg"));
            assertFalse(new File(pc.inbox, "IMG_2001.jpg").exists());
        }
    }
}
