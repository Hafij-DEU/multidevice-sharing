package io.github.hafijbge.meshdrop.engine.net;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;

import java.io.BufferedReader;
import java.io.File;
import java.io.InputStreamReader;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.Random;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;
import org.junit.After;
import org.junit.Before;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

/** The RFC 6455 client against the `ws` library (what the Node hub uses). */
public class WebSocketTest {
    @Rule public TemporaryFolder tmp = new TemporaryFolder();

    static final String SERVER = String.join("\n",
            "import { createRequire } from 'node:module';",
            "const require = createRequire(process.env.CORE + '/package.json');",
            "const { WebSocketServer } = require('ws');",
            "const wss = new WebSocketServer({ port: 0, host: '127.0.0.1', maxPayload: 70 * 1024 * 1024 });",
            "wss.on('listening', () => console.log('PORT ' + wss.address().port));",
            "wss.on('connection', (ws, req) => {",
            "  console.log('PATH ' + req.url + ' HOST ' + req.headers.host);",
            "  ws.on('pong', (d) => console.log('PONG ' + d.toString()));",
            "  ws.on('close', (code) => console.log('CLOSED ' + code));",
            "  ws.on('message', (data, isBinary) => {",
            "    const s = isBinary ? '' : data.toString();",
            "    if (s === 'revoke') return ws.close(4403, 'revoked');",
            "    if (s === 'ping-me') return ws.ping(Buffer.from('srv'));",
            "    if (s === 'frag') { ws.send('hel', { fin: false }); ws.send('lo', { fin: true }); return; }",
            "    if (s === 'big') return ws.send(Buffer.alloc(2 * 1024 * 1024, 7));",
            "    ws.send(data, { binary: isBinary });",
            "  });",
            "});");

    Process server;
    BlockingQueue<String> lines = new LinkedBlockingQueue<>();
    int port;

    static final class Events implements WebSocket.Listener {
        final BlockingQueue<Object> q = new LinkedBlockingQueue<>();

        @Override
        public void onText(String text) {
            q.add(text);
        }

        @Override
        public void onBinary(byte[] data) {
            q.add(data);
        }

        @Override
        public void onClose(int code, String reason) {
            q.add("close " + code + " " + reason);
        }

        @Override
        public void onPong(byte[] data) {
            q.add("pong " + new String(data, StandardCharsets.UTF_8));
        }

        Object next() throws InterruptedException {
            Object o = q.poll(20, TimeUnit.SECONDS);
            assertNotNull("no event", o);
            return o;
        }
    }

    @Before
    public void start() throws Exception {
        File js = tmp.newFile("echo.mjs");
        Files.write(js.toPath(), SERVER.getBytes(StandardCharsets.UTF_8));
        ProcessBuilder pb = new ProcessBuilder("node", js.getPath()).redirectErrorStream(true);
        pb.environment().put("CORE", System.getProperty("meshdrop.repo") + "/packages/core");
        server = pb.start();
        Thread t = new Thread(() -> {
            try (BufferedReader r = new BufferedReader(new InputStreamReader(server.getInputStream(), StandardCharsets.UTF_8))) {
                for (String l; (l = r.readLine()) != null; ) lines.add(l);
            } catch (Exception ignored) {
                // process ended
            }
        });
        t.setDaemon(true);
        t.start();
        String first = lines.poll(20, TimeUnit.SECONDS);
        assertNotNull(first);
        port = Integer.parseInt(first.replace("PORT ", "").trim());
    }

    @After
    public void stop() {
        if (server != null) server.destroyForcibly();
    }

    String line(String prefix) throws InterruptedException {
        for (;;) {
            String l = lines.poll(20, TimeUnit.SECONDS);
            assertNotNull("no line " + prefix, l);
            if (l.startsWith(prefix)) return l;
        }
    }

    WebSocket connect(Events ev, int maxMessage) throws Exception {
        Socket s = new Socket();
        s.connect(new InetSocketAddress("127.0.0.1", port), 5000);
        return WebSocket.connect(s, "127.0.0.1:" + port, "/mesh/v1/hub", ev, maxMessage);
    }

    @Test
    public void echoesTextFragmentsAnd8MiBBinary() throws Exception {
        Events ev = new Events();
        WebSocket ws = connect(ev, WebSocket.DEFAULT_MAX_MESSAGE);
        assertEquals("PATH /mesh/v1/hub HOST 127.0.0.1:" + port, line("PATH"));
        ws.sendText("héllo");
        assertEquals("héllo", ev.next());
        ws.sendText("frag");
        assertEquals("hello", ev.next());
        byte[] big = new byte[8 << 20];
        new Random(1).nextBytes(big);
        ws.sendBinary(big);
        assertArrayEquals(big, (byte[]) ev.next());
        ws.ping("cli".getBytes(StandardCharsets.UTF_8));
        assertEquals("pong cli", ev.next());
        ws.sendText("ping-me");
        assertEquals("PONG srv", line("PONG"));
        ws.close(1000, "bye");
        assertEquals("close 1000 bye", ev.next());
        assertEquals("CLOSED 1000", line("CLOSED"));
    }

    @Test
    public void aServerCloseCodeReachesTheListener() throws Exception {
        Events ev = new Events();
        WebSocket ws = connect(ev, WebSocket.DEFAULT_MAX_MESSAGE);
        ws.sendText("revoke");
        assertEquals("close 4403 revoked", ev.next());
        assertEquals("CLOSED 4403", line("CLOSED"));
    }

    @Test
    public void anOversizedMessageClosesWith1009() throws Exception {
        Events ev = new Events();
        WebSocket ws = connect(ev, 1 << 20);
        ws.sendText("big");
        assertEquals("close 1009 message too big", ev.next());
        assertEquals("CLOSED 1009", line("CLOSED"));
    }
}
