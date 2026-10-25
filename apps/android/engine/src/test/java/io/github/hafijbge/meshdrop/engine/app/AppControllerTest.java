package io.github.hafijbge.meshdrop.engine.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import io.github.hafijbge.meshdrop.engine.Engine;
import io.github.hafijbge.meshdrop.engine.EngineConfig;
import io.github.hafijbge.meshdrop.engine.identity.PlainKeyVault;
import io.github.hafijbge.meshdrop.engine.recv.DirectorySink;
import io.github.hafijbge.meshdrop.engine.send.PathSource;
import io.github.hafijbge.meshdrop.engine.send.SendItem;
import io.github.hafijbge.meshdrop.engine.util.Json;
import java.io.File;
import java.net.ServerSocket;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.After;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

/** Ports apps/desktop/test/controller.test.ts (the cases that apply without a mesh). */
public class AppControllerTest {
    @Rule public TemporaryFolder tmp = new TemporaryFolder();
    final List<AppController> ctls = new ArrayList<>();

    @After
    public void stopAll() {
        for (AppController c : ctls) c.stop();
    }

    static class FakePlatform implements Platform {
        final List<String> clip = Collections.synchronizedList(new ArrayList<>());
        final List<String> notes = Collections.synchronizedList(new ArrayList<>());
        volatile String clipboardText = "";
        volatile List<String> clipboardUris = new ArrayList<>();
        final List<List<String>> clipFilesWritten = Collections.synchronizedList(new ArrayList<>());

        @Override
        public List<String> clipboardUris() {
            return clipboardUris;
        }

        @Override
        public void writeClipboardFiles(List<String> refs) {
            clipFilesWritten.add(new ArrayList<>(refs));
            clipboardUris = new ArrayList<>(refs);
        }

        public void notify(String title, String body, String openRef) {
            notes.add(title + ": " + body);
        }

        public void writeClipboard(String text) {
            clip.add(text);
        }

        public String readClipboard() {
            return clipboardText;
        }

        public void openInbox() {}

        public void reveal(String ref) {}

        public SendItem item(String kind, String path) {
            return kind.equals("dir") ? SendItem.dir(PathSource.tree(Path.of(path))) : SendItem.file(PathSource.file(Path.of(path)));
        }

        public void decorate(Map<String, Object> state) {
            state.put("platform", "android");
        }

        final List<Boolean> rings = Collections.synchronizedList(new ArrayList<>());
        final List<String> urls = Collections.synchronizedList(new ArrayList<>());
        final List<String> replies = Collections.synchronizedList(new ArrayList<>());

        @Override
        public void ring(boolean on) {
            rings.add(on);
        }

        @Override
        public Map<String, Object> status() {
            Map<String, Object> b = new java.util.LinkedHashMap<>();
            b.put("level", 77L);
            b.put("charging", false);
            Map<String, Object> m = new java.util.LinkedHashMap<>();
            m.put("battery", b);
            return m;
        }

        @Override
        public void openUrl(String url) {
            urls.add(url);
        }

        @Override
        public boolean replyNotification(String key, String text) {
            if (!key.equals("k1")) return false;
            replies.add(text);
            return true;
        }
    }

    static final class Node {
        AppController c;
        FakePlatform p;
        File home;
        File inbox;
    }

    Node make(String alias, Map<String, Object> over) throws Exception {
        Node n = new Node();
        n.home = tmp.newFolder();
        n.inbox = new File(n.home, "inbox");
        Settings defaults = Settings.defaults(alias);
        defaults.port = 0;
        defaults.discovery = false;
        SettingsStore settings = new SettingsStore(new File(n.home, "android-settings.json"), defaults);
        if (over != null) settings.set(over);
        n.p = new FakePlatform();
        File inbox = n.inbox;
        File home = n.home;
        n.c = new AppController(settings, new HistoryStore(new File(n.home, "desktop-history.json")), n.p, s -> {
            EngineConfig cfg = new EngineConfig(home, new PlainKeyVault(), new DirectorySink(inbox));
            cfg.port = s.port;
            cfg.alias = s.alias;
            cfg.discovery = s.discovery;
            return Engine.create(cfg);
        });
        ctls.add(n.c);
        n.c.start();
        return n;
    }

    Node make(String alias) throws Exception {
        return make(alias, null);
    }

    @SuppressWarnings("unchecked")
    static Map<String, Object> state(AppController c) {
        return (Map<String, Object>) Json.parse(c.stateJson());
    }

    @SuppressWarnings("unchecked")
    static List<Map<String, Object>> list(Map<String, Object> s, String k) {
        return (List<Map<String, Object>>) s.get(k);
    }

    static String selfId(AppController c) {
        return (String) ((Map<?, ?>) state(c).get("self")).get("deviceId");
    }

    static int selfPort(AppController c) {
        return ((Long) ((Map<?, ?>) state(c).get("self")).get("port")).intValue();
    }

    static void pair(AppController a, AppController b) throws Exception {
        a.addByAddress("127.0.0.1", selfPort(b), "bee");
        b.addByAddress("127.0.0.1", selfPort(a), "ay");
    }

    static void until(java.util.function.BooleanSupplier c, long ms) throws InterruptedException {
        long end = System.currentTimeMillis() + ms;
        while (!c.getAsBoolean()) {
            if (System.currentTimeMillis() > end) throw new AssertionError("condition not met in time");
            Thread.sleep(25);
        }
    }

    static Map<String, Object> input(String kind, String path) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("kind", kind);
        m.put("path", path);
        return m;
    }

    @Test
    public void pairsByAddressSendsAFileAndBothSidesSeeIt() throws Exception {
        Node a = make("alpha"), b = make("beta");
        pair(a.c, b.c);
        File f = new File(tmp.getRoot(), "hello.txt");
        Files.write(f.toPath(), "hello world".getBytes(StandardCharsets.UTF_8));
        String bId = selfId(b.c);
        a.c.send(List.of(bId), List.of(input("file", f.getPath())));
        until(() -> list(state(a.c), "transfers").stream().anyMatch(t -> "out".equals(t.get("direction")) && "done".equals(t.get("status"))), 15_000);
        Map<String, Object> t = list(state(a.c), "transfers").get(0);
        assertEquals("bee", t.get("alias"));
        assertEquals(1L, t.get("files"));
        assertEquals(11L, t.get("bytes"));
        until(() -> list(state(b.c), "received").size() == 1, 15_000);
        Map<String, Object> r = list(state(b.c), "received").get(0);
        assertEquals("ay", r.get("alias"));
        assertEquals(List.of(new File(b.inbox, "hello.txt").getAbsolutePath()), r.get("files"));
        assertEquals("android", state(b.c).get("platform"));
        assertEquals(1, b.p.notes.size());
    }

    /** A phone with a camera roll: files in a folder, MediaStore ids 1, 2, 3… */
    static final class CameraPlatform extends FakePlatform {
        final List<File> roll = Collections.synchronizedList(new ArrayList<>());

        @Override
        public boolean supportsBackup() {
            return true;
        }

        @Override
        public boolean mediaPermission() {
            return true;
        }

        @Override
        public List<Platform.Media> cameraMediaAfter(long afterId, int limit) {
            List<Platform.Media> out = new ArrayList<>();
            for (int i = 0; i < roll.size() && out.size() < limit; i++) if (i + 1 > afterId) out.add(new Platform.Media(i + 1, roll.get(i).getPath()));
            return out;
        }

        @Override
        public long cameraMediaMaxId() {
            return roll.size();
        }
    }

    @Test
    public void photoBackupSendsOnlyNewCameraPhotosToThePcOnce() throws Exception {
        File pcHome = tmp.newFolder();
        try (io.github.hafijbge.meshdrop.engine.testutil.NodeListen pc = io.github.hafijbge.meshdrop.engine.testutil.NodeListen.start(pcHome)) {
            File home = tmp.newFolder();
            Settings defaults = Settings.defaults("Pixel");
            defaults.port = 0;
            defaults.discovery = false;
            CameraPlatform p = new CameraPlatform();
            File roll = tmp.newFolder("DCIM");
            for (String n : new String[] {"old1.jpg", "old2.jpg"}) {
                File f = new File(roll, n);
                Files.write(f.toPath(), n.getBytes(StandardCharsets.UTF_8));
                p.roll.add(f);
            }
            AppController c = new AppController(new SettingsStore(new File(home, "android-settings.json"), defaults), new HistoryStore(new File(home, "h.json")), p, s -> {
                EngineConfig cfg = new EngineConfig(home, new PlainKeyVault(), new DirectorySink(new File(home, "inbox")));
                cfg.port = s.port;
                cfg.alias = s.alias;
                cfg.discovery = false;
                cfg.guestPort = -1;
                return Engine.create(cfg);
            });
            ctls.add(c);
            c.start();
            c.addByAddress("127.0.0.1", pc.port, "pc");
            io.github.hafijbge.meshdrop.engine.testutil.Node.Result r = io.github.hafijbge.meshdrop.engine.testutil.Node.run("pair", "127.0.0.1:" + selfPort(c), "Pixel", "--home", pcHome.getPath());
            assertEquals(r.out, 0, r.code);
            c.backupSet(pc.deviceId, false); // only new ones: old1/old2 stay
            File shot = new File(roll, "IMG_3.jpg");
            Files.write(shot.toPath(), "new".getBytes(StandardCharsets.UTF_8));
            p.roll.add(shot);
            c.backupNow();
            File landed = new File(pcHome, "backup/Pixel/IMG_3.jpg");
            until(landed::exists, 20_000);
            until(() -> ((Map<?, ?>) state(c).get("backup")).get("count").equals(1L), 10_000);
            c.backupNow(); // nothing new: nothing sent again
            Thread.sleep(1500);
            assertFalse(new File(pcHome, "backup/Pixel/IMG_3 (1).jpg").exists());
            assertFalse(new File(pcHome, "backup/Pixel/old1.jpg").exists());
            assertEquals(3L, ((Map<?, ?>) state(c).get("settings")).get("backupSince"));
        }
    }

    @Test
    public void sharedClipboardIsCheckedOnlyWhileTheAppIsInFront() throws Exception {
        Map<String, Object> on = new LinkedHashMap<>();
        on.put("clipboardSync", true);
        Node a = make("alpha", on), b = make("beta");
        pair(a.c, b.c);
        a.p.clipboardText = "before";
        a.c.setForeground(true);
        Thread.sleep(1500); // the first look only takes note
        a.p.clipboardText = "copied in front";
        until(() -> b.p.clip.contains("copied in front"), 15_000);
        a.c.setForeground(false);
        a.p.clipboardText = "copied in the background";
        Thread.sleep(2500);
        assertFalse(b.p.clip.contains("copied in the background"));
        assertFalse(b.p.clip.contains("before"));
    }

    @Test
    public void copiedFilesGoOnTheOtherDevicesClipboardWithoutEcho() throws Exception {
        Map<String, Object> on = new LinkedHashMap<>();
        on.put("clipboardSync", true);
        Node a = make("alpha", on), b = make("beta", on);
        pair(a.c, b.c);
        a.c.setForeground(true);
        b.c.setForeground(true);
        Thread.sleep(1500);
        File f = new File(tmp.getRoot(), "photo.jpg");
        Files.write(f.toPath(), "jpeg".getBytes(StandardCharsets.UTF_8));
        a.p.clipboardUris = List.of(f.getPath());
        until(() -> b.p.clipFilesWritten.size() == 1, 15_000);
        assertEquals(List.of(new File(b.inbox, "photo.jpg").getAbsolutePath()), b.p.clipFilesWritten.get(0));
        Thread.sleep(2500);
        assertTrue(a.p.clipFilesWritten.isEmpty()); // b did not send it back
    }

    @Test
    public void clipboardGoesOnTheClipboardOnlyWhenClipboardReceiveIsOn() throws Exception {
        Node a = make("a"), b = make("b"), c = make("c", Map.of("clipboardReceive", false));
        pair(a.c, b.c);
        pair(a.c, c.c);
        a.p.clipboardText = "secret clip $(rm -rf ~)";
        a.c.sendClipboard(List.of(selfId(b.c), selfId(c.c)));
        until(() -> list(state(b.c), "received").size() == 1 && list(state(c.c), "received").size() == 1, 15_000);
        assertEquals(List.of("secret clip $(rm -rf ~)"), b.p.clip);
        assertEquals(List.of(), c.p.clip);
        assertEquals(true, list(state(c.c), "received").get(0).get("clipboard"));
    }

    @Test
    public void throttlesStateUpdatesWhileALargeFolderTransfers() throws Exception {
        Node a = make("a"), b = make("b");
        pair(a.c, b.c);
        File dir = tmp.newFolder("many");
        for (int i = 0; i < 2000; i++) Files.write(new File(dir, "f" + i + ".txt").toPath(), ("file " + i).getBytes(StandardCharsets.UTF_8));
        String bId = selfId(b.c);
        AtomicInteger updates = new AtomicInteger();
        a.c.addStateListener(json -> {
            if (json.contains("\"sent\":") && !json.contains("\"sent\":0,")) updates.incrementAndGet();
        });
        long t0 = System.currentTimeMillis();
        a.c.send(List.of(bId), List.of(input("dir", dir.getPath())));
        until(() -> list(state(a.c), "transfers").stream().anyMatch(t -> "done".equals(t.get("status"))), 120_000);
        Thread.sleep(250);
        double secs = (System.currentTimeMillis() - t0) / 1000.0;
        assertTrue(updates.get() > 0);
        assertTrue(updates.get() + " updates in " + secs + " s", updates.get() <= Math.ceil(secs * 10) + 2);
    }

    @Test
    public void passesAHostilePeerAliasThroughStateAsPlainData() throws Exception {
        Node a = make("a"), b = make("b");
        String evil = "<img src=x onerror=alert(1)>‮";
        a.c.addByAddress("127.0.0.1", selfPort(b.c), evil);
        assertEquals(evil, list(state(a.c), "devices").stream().filter(d -> d.get("deviceId").equals(selfId(b.c))).findFirst().get().get("alias"));
    }

    @Test
    public void refusesAPortInUseAndKeepsServingOnTheOldOne() throws Exception {
        Node a = make("a");
        int old = selfPort(a.c);
        try (ServerSocket blocker = new ServerSocket(0)) {
            try {
                a.c.setSettings(Map.of("port", (long) blocker.getLocalPort()));
                fail("expected a refusal");
            } catch (SettingsStore.SettingsError e) {
                assertTrue(e.getMessage(), e.getMessage().contains("in use"));
            }
            assertEquals(0L, ((Map<?, ?>) state(a.c).get("settings")).get("port"));
            assertEquals(old, selfPort(a.c));
        }
    }

    @Test
    public void keepsTwoConcurrentSendsToOneDeviceApart() throws Exception {
        Node a = make("a"), b = make("b");
        pair(a.c, b.c);
        String bId = selfId(b.c);
        File f = new File(tmp.getRoot(), "big.bin");
        Files.write(f.toPath(), new byte[48 * 1024 * 1024]);
        a.c.send(List.of(bId), List.of(input("file", f.getPath())));
        until(() -> list(state(a.c), "transfers").stream().anyMatch(t -> ((Long) t.get("sent")) > 0), 30_000);
        a.p.clipboardText = "meanwhile";
        a.c.sendClipboard(List.of(bId));
        until(() -> {
            List<Map<String, Object>> outs = list(state(a.c), "transfers");
            return outs.size() == 2 && outs.stream().allMatch(t -> "done".equals(t.get("status")));
        }, 90_000);
        Thread.sleep(300);
        assertEquals(2, list(state(a.c), "transfers").size());
        Map<String, Object> big = list(state(a.c), "transfers").stream().filter(t -> ((Long) t.get("files")) == 1).findFirst().get();
        assertEquals(48L * 1024 * 1024, big.get("sent"));
    }

    @Test
    public void startsWithoutReceivingWhenItsPortIsTakenAndRecoversFromSettings() throws Exception {
        try (ServerSocket blocker = new ServerSocket(0)) {
            Node a = make("a", Map.of("port", (long) blocker.getLocalPort()));
            Map<String, Object> s = state(a.c);
            assertTrue(String.valueOf(s.get("error")), String.valueOf(s.get("error")).contains("in use"));
            assertEquals(false, s.get("receiving"));
            a.c.setSettings(Map.of("port", 0L));
            Map<String, Object> s2 = state(a.c);
            assertEquals(null, s2.get("error"));
            assertEquals(true, s2.get("receiving"));
        }
    }

    @Test
    public void meshActionsAreNotAvailableYet() throws Exception {
        Node a = make("a");
        try {
            a.c.call("hubInit", List.of(List.of()));
            fail("expected a refusal");
        } catch (IllegalStateException e) {
            assertTrue(e.getMessage().contains("not available"));
        }
    }

    @Test
    @SuppressWarnings("unchecked")
    public void joinsAMeshFromAnInviteAndShowsItsMembers() throws Exception {
        File hubHome = tmp.newFolder("hub");
        io.github.hafijbge.meshdrop.engine.testutil.NodeMesh.hubInit(hubHome);
        try (io.github.hafijbge.meshdrop.engine.testutil.NodeListen hub = io.github.hafijbge.meshdrop.engine.testutil.NodeListen.start(hubHome)) {
            io.github.hafijbge.meshdrop.engine.testutil.Node.Result inv = io.github.hafijbge.meshdrop.engine.testutil.Node.run("invite", "--home", hubHome.getPath());
            assertEquals(inv.out, 0, inv.code);
            Node a = make("a");
            assertEquals("none", ((Map<String, Object>) state(a.c).get("hub")).get("role"));
            assertEquals("member", a.c.call("join", List.of(inv.out.split("\n")[0].trim())));
            until(() -> Boolean.TRUE.equals(((Map<String, Object>) state(a.c).get("hub")).get("online")), 15_000);
            Map<String, Object> st = state(a.c);
            Map<String, Object> h = (Map<String, Object>) st.get("hub");
            assertEquals("member", h.get("role"));
            assertEquals(2L, h.get("members"));
            List<Map<String, Object>> ms = list(st, "members");
            assertEquals(2, ms.size());
            boolean self = false;
            boolean theHub = false;
            for (Map<String, Object> m : ms) {
                if (Boolean.TRUE.equals(m.get("self")) && "member".equals(m.get("role"))) self = true;
                if (hub.deviceId.equals(m.get("deviceId")) && "hub".equals(m.get("role"))) theHub = true;
            }
            assertTrue(ms.toString(), self && theHub);
            boolean listed = false;
            for (Map<String, Object> d : list(st, "devices")) if (hub.deviceId.equals(d.get("deviceId")) && "hub".equals(d.get("role"))) listed = true;
            assertTrue("the hub shows as a device", listed);
            io.github.hafijbge.meshdrop.engine.testutil.Node.Result members = io.github.hafijbge.meshdrop.engine.testutil.Node.run("members", "--home", hubHome.getPath());
            assertTrue(members.out, members.out.contains("a "));
        }
    }

    @Test
    public void stateJsonParsesInNodeWithEveryAppStateKey() throws Exception {
        Node a = make("a");
        File f = new File(tmp.getRoot(), "state.json");
        Files.write(f.toPath(), a.c.stateJson().getBytes(StandardCharsets.UTF_8));
        String script = "const s=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'));"
                + "for (const k of ['self','mode','hub','devices','transfers','outbox','received','settings','receiving','members','platform']) if (!(k in s)) { console.error('missing '+k); process.exit(1); }"
                + "for (const k of ['alias','inbox','port','discovery','autostart','startHidden','closeToTray','clipboardReceive','notifications']) if (!(k in s.settings)) { console.error('missing settings.'+k); process.exit(1); }"
                + "if (typeof s.self.port !== 'number' || s.hub.role !== 'none') process.exit(1);";
        Process p = new ProcessBuilder("node", "-e", script, f.getPath()).redirectErrorStream(true).start();
        assertTrue(p.waitFor(30, java.util.concurrent.TimeUnit.SECONDS));
        assertEquals(new String(p.getInputStream().readAllBytes(), StandardCharsets.UTF_8), 0, p.exitValue());
    }

    @Test
    public void aRemovedStateListenerIsNoLongerCalled() throws Exception {
        Node a = make("a");
        AtomicInteger calls = new AtomicInteger();
        AppController.StateListener l = json -> calls.incrementAndGet();
        a.c.addStateListener(l);
        a.c.refresh();
        until(() -> calls.get() > 0, 5_000);
        a.c.removeStateListener(l);
        int n = calls.get();
        a.c.refresh();
        Thread.sleep(400);
        assertEquals(n, calls.get());
    }

    @Test
    @SuppressWarnings("unchecked")
    public void m10AppMessagesRingStatusReplyAndOpenUrl() throws Exception {
        Node a = make("ay");
        Node b = make("bee");
        pair(a.c, b.c);
        String bId = selfId(b.c);
        Map<String, Object> r = (Map<String, Object>) a.c.call("appSend", List.of(bId, Map.of("kind", "ring")));
        assertEquals(200L, r.get("status"));
        assertEquals(List.of(true), b.p.rings);
        assertEquals(true, state(b.c).get("ringing"));
        b.c.call("ringStop", List.of());
        assertEquals(List.of(true, false), b.p.rings);

        r = (Map<String, Object>) a.c.call("appSend", List.of(bId, Map.of("kind", "status")));
        assertEquals(200L, r.get("status"));
        assertEquals(77L, ((Map<String, Object>) ((Map<String, Object>) ((Map<String, Object>) state(a.c).get("deviceStatus")).get(bId)).get("battery")).get("level"));

        r = (Map<String, Object>) a.c.call("appSend", List.of(bId, Map.of("kind", "reply", "key", "k1", "text", "on my way")));
        assertEquals(200L, r.get("status"));
        assertEquals(List.of("on my way"), b.p.replies);
        r = (Map<String, Object>) a.c.call("appSend", List.of(bId, Map.of("kind", "reply", "key", "old", "text", "x")));
        assertEquals(404L, r.get("status"));

        r = (Map<String, Object>) a.c.call("appSend", List.of(bId, Map.of("kind", "open-url", "url", "intent://evil")));
        assertEquals(400L, r.get("status"));
        r = (Map<String, Object>) a.c.call("appSend", List.of(bId, Map.of("kind", "open-url", "url", "https://example.com/x")));
        assertEquals(200L, r.get("status"));
        assertEquals(List.of("https://example.com/x"), b.p.urls);

        r = (Map<String, Object>) a.c.call("appSend", List.of(bId, Map.of("kind", "input", "events", List.of())));
        assertEquals(403L, r.get("status"));
    }
}
