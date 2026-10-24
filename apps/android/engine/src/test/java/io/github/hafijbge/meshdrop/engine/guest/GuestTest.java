package io.github.hafijbge.meshdrop.engine.guest;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import io.github.hafijbge.meshdrop.engine.Engine;
import io.github.hafijbge.meshdrop.engine.EngineConfig;
import io.github.hafijbge.meshdrop.engine.EngineEvent;
import io.github.hafijbge.meshdrop.engine.identity.PlainKeyVault;
import io.github.hafijbge.meshdrop.engine.recv.DirectorySink;
import io.github.hafijbge.meshdrop.engine.send.PathSource;
import io.github.hafijbge.meshdrop.engine.util.Json;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import org.junit.After;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

/** The Android guest server against a plain HTTP client, the way the guest page's script uses it. */
public class GuestTest {
    @Rule public TemporaryFolder tmp = new TemporaryFolder();
    private Engine engine;

    @After
    public void stop() {
        if (engine != null) engine.stop();
    }

    static final class Res {
        int status;
        String body;
        String cookie;
        String header;
    }

    static Res http(String method, String url, Map<String, String> headers, byte[] body, String wantHeader) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setRequestMethod(method);
        for (Map.Entry<String, String> h : headers.entrySet()) c.setRequestProperty(h.getKey(), h.getValue());
        if (body != null) {
            c.setDoOutput(true);
            try (OutputStream o = c.getOutputStream()) {
                o.write(body);
            }
        }
        Res r = new Res();
        r.status = c.getResponseCode();
        InputStream in = r.status >= 400 ? c.getErrorStream() : c.getInputStream();
        ByteArrayOutputStream b = new ByteArrayOutputStream();
        if (in != null) in.transferTo(b);
        r.body = b.toString(StandardCharsets.UTF_8.name());
        String sc = c.getHeaderField("Set-Cookie");
        if (sc != null) r.cookie = sc.substring(0, sc.indexOf(';'));
        if (wantHeader != null) r.header = c.getHeaderField(wantHeader);
        return r;
    }

    @Test
    @SuppressWarnings("unchecked")
    public void aGuestSendsAfterTheOwnerAcceptsAndDownloadsWhatIsShared() throws Exception {
        File home = tmp.newFolder();
        File inbox = new File(home, "inbox");
        EngineConfig cfg = new EngineConfig(home, new PlainKeyVault(), new DirectorySink(inbox));
        cfg.port = 0;
        cfg.guestPort = 0;
        cfg.discovery = false;
        cfg.alias = "phone";
        cfg.lanAddrs = () -> List.of(new io.github.hafijbge.meshdrop.engine.hub.HubClient.LanAddr("127.0.0.1", 0));
        engine = Engine.create(cfg);
        List<EngineEvent> events = Collections.synchronizedList(new ArrayList<>());
        engine.addListener(events::add);
        engine.start();

        Map<String, Object> g = engine.guestStart(60, 0);
        String url = (String) g.get("url");
        assertTrue(url, url.startsWith("http://127.0.0.1:" + engine.guestPort() + "/g/"));
        assertTrue(((String) g.get("qrSvg")).startsWith("<svg"));
        String token = url.substring(url.lastIndexOf('/') + 1);
        String base = "http://127.0.0.1:" + engine.guestPort() + "/g/";

        Res page = http("GET", url, Map.of(), null, null);
        assertEquals(200, page.status);
        assertTrue(page.body.contains(token));
        Res other = http("GET", url, Map.of(), null, null);
        assertEquals(410, other.status); // one browser only
        Map<String, String> auth = Map.of("X-Guest-Token", token, "Cookie", page.cookie);
        assertEquals(410, http("GET", base + "api/session", Map.of("X-Guest-Token", token), null, null).status);
        Res session = http("GET", base + "api/session", auth, null, null);
        assertEquals("phone", ((Map<String, Object>) Json.parse(session.body)).get("owner"));

        // Send: offer -> owner accepts -> two slices -> the file lands in the inbox.
        byte[] data = "hello from a browser".getBytes(StandardCharsets.UTF_8);
        Res offer = http("POST", base + "api/offers", Map.of("X-Guest-Token", token, "Cookie", page.cookie, "Content-Type", "application/json"),
                ("{\"files\":[{\"name\":\"note.txt\",\"size\":" + data.length + "}],\"text\":\"hi\"}").getBytes(StandardCharsets.UTF_8), null);
        assertEquals(201, offer.status);
        String id = (String) ((Map<String, Object>) Json.parse(offer.body)).get("id");
        assertEquals(409, http("PUT", base + "api/offers/" + id + "/0?offset=0", auth, data, null).status); // not accepted yet
        assertEquals(1, ((List<Object>) engine.guestState().get("offers")).size());
        assertTrue(events.stream().anyMatch(e -> e.source.equals("guest") && e.type.equals("offer")));
        engine.guestAccept(id);
        assertEquals(200, http("PUT", base + "api/offers/" + id + "/0?offset=0", auth, java.util.Arrays.copyOf(data, 5), null).status);
        Res wrong = http("PUT", base + "api/offers/" + id + "/0?offset=0", auth, data, null);
        assertEquals(409, wrong.status);
        assertTrue(wrong.body.contains("\"received\":5"));
        Res last = http("PUT", base + "api/offers/" + id + "/0?offset=5", auth, java.util.Arrays.copyOfRange(data, 5, data.length), null);
        assertEquals(200, last.status);
        assertEquals("done", ((Map<String, Object>) Json.parse(http("GET", base + "api/offers/" + id, auth, null, null).body)).get("status"));
        assertEquals("hello from a browser", Files.readString(new File(inbox, "note.txt").toPath()));
        assertTrue(events.stream().anyMatch(e -> e.source.equals("guest") && e.type.equals("received") && "hi".equals(e.data.get("text"))));

        // Download: a shared file, whole and by range.
        File shared = new File(tmp.getRoot(), "photo.bin");
        Files.write(shared.toPath(), "0123456789".getBytes(StandardCharsets.UTF_8));
        String sid = (String) engine.guestShare(List.of(PathSource.file(shared.toPath()))).get(0).get("id");
        assertTrue(http("GET", base + "api/shared", auth, null, null).body.contains("photo.bin"));
        Res whole = http("GET", base + "api/shared/" + sid + "?t=" + token, Map.of("Cookie", page.cookie), null, "Content-Disposition");
        assertEquals(200, whole.status);
        assertEquals("0123456789", whole.body);
        assertTrue(whole.header.contains("photo.bin"));
        Res part = http("GET", base + "api/shared/" + sid + "?t=" + token, Map.of("Cookie", page.cookie, "Range", "bytes=3-5"), null, "Content-Range");
        assertEquals(206, part.status);
        assertEquals("345", part.body);
        assertEquals("bytes 3-5/10", part.header);

        // End: the link and its API are gone.
        engine.guestEnd();
        assertEquals(410, http("GET", base + "api/session", auth, null, null).status);
        assertEquals(410, http("GET", url, Map.of(), null, null).status);
        assertEquals(false, engine.guestState().get("active"));
    }

    @Test
    public void theQrCodeIsAnSvgOfDarkModules() {
        String svg = GuestPage.qrSvg("http://192.168.1.5:53320/g/abcdefghijklmnopqrstuv");
        assertTrue(svg.startsWith("<svg xmlns=\"http://www.w3.org/2000/svg\""));
        assertTrue(svg.contains("fill=\"#000000\" d=\"M"));
    }
}
