package io.github.hafijbge.meshdrop.engine.interop;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import io.github.hafijbge.meshdrop.engine.Engine;
import io.github.hafijbge.meshdrop.engine.EngineConfig;
import io.github.hafijbge.meshdrop.engine.bt.BtPlatform;
import io.github.hafijbge.meshdrop.engine.bt.LinkPolicy;
import io.github.hafijbge.meshdrop.engine.identity.PlainKeyVault;
import io.github.hafijbge.meshdrop.engine.recv.DirectorySink;
import java.io.BufferedReader;
import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.TimeUnit;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

/** M14: the phone plays a PC's sound and sends app messages to a Node engine over a Bluetooth link (RFCOMM faked as loopback TCP). */
public class BtStreamInteropTest {
    @Rule public TemporaryFolder tmp = new TemporaryFolder();

    static final String PC = String.join("\n",
            "import * as readline from 'node:readline';",
            "import { createServer } from 'node:net';",
            "const { Engine } = await import(process.env.CORE + 'engine.ts');",
            "let accept = null;",
            "const rfcomm = createServer((s) => accept && accept(s, 'AA:AA:AA:AA:AA:AA'));",
            "await new Promise((r) => rfcomm.listen(0, '127.0.0.1', r));",
            "const bt = { bonded: async () => [{ address: 'AA:AA:AA:AA:AA:AA', name: 'phone' }], dial: async () => { throw new Error('host is down'); }, listen: async (f) => { accept = f; }, stop: () => { accept = null; } };",
            "const e = await Engine.create({ home: process.argv[2], inbox: process.argv[2] + '/inbox', port: 0, discovery: false, alias: 'pc', hub: { ingressPort: 0 }, guest: false, localsend: false, bt: { platform: bt, tickMs: 0 } });",
            "await e.start();",
            "e.setStreamHandler((s) => {",
            "  if (s.method === 'GET' && s.path === 'audio') { s.res.writeHead(200, { 'content-type': 'audio/opus-rtp; channels=2' }); s.res.end(Buffer.alloc(20000, s.query?.get('codec') === 'opus' ? 7 : 5)); return true; }",
            "  return false;",
            "});",
            "e.setAppHandler?.(async (peer, msg) => ({ status: 200, body: { peer, msg } }));",
            "console.log(JSON.stringify({ port: e.port, id: e.identity.deviceId, rfcomm: rfcomm.address().port }));",
            "const rl = readline.createInterface({ input: process.stdin });",
            "for await (const line of rl) { const [, p] = line.split(' '); await e.pairManual('127.0.0.1', Number(p), 'phone'); console.log(JSON.stringify({ paired: true })); }");

    static final class TcpConn implements BtPlatform.Conn {
        final Socket s;

        TcpConn(Socket s) {
            this.s = s;
        }

        @Override
        public InputStream in() throws IOException {
            return s.getInputStream();
        }

        @Override
        public OutputStream out() throws IOException {
            return s.getOutputStream();
        }

        @Override
        public void close() throws IOException {
            s.close();
        }
    }

    @Test(timeout = 90_000)
    @SuppressWarnings("unchecked")
    public void playsPcSoundOverBluetooth() throws Exception {
        File dir = tmp.newFolder("script");
        File js = new File(dir, "pc.mts");
        Files.write(js.toPath(), PC.getBytes(StandardCharsets.UTF_8));
        File pcHome = tmp.newFolder("pc");
        ProcessBuilder pb = new ProcessBuilder("node", js.getPath(), pcHome.getPath()).redirectErrorStream(true);
        pb.environment().put("CORE", new File(System.getProperty("meshdrop.repo"), "packages/core/src").toURI().toString());
        Process p = pb.start();
        BufferedReader out = new BufferedReader(new InputStreamReader(p.getInputStream(), StandardCharsets.UTF_8));
        Map<String, Object> hello = (Map<String, Object>) io.github.hafijbge.meshdrop.engine.util.Json.parse(out.readLine());
        int pcPort = ((Long) hello.get("port")).intValue();
        String pcId = (String) hello.get("id");
        int rfcomm = ((Long) hello.get("rfcomm")).intValue();

        File jHome = tmp.newFolder("phone");
        EngineConfig c = new EngineConfig(jHome, new PlainKeyVault(), new DirectorySink(new File(jHome, "inbox")));
        c.port = 0;
        c.discovery = false;
        c.autoResume = false;
        c.alias = "phone";
        c.btTickMs = 0;
        c.bt = new BtPlatform() {
            @Override
            public List<Bonded> bonded() {
                return Collections.singletonList(new Bonded("PC:PC:PC:PC:PC:PC", "pc"));
            }

            @Override
            public Conn dial(String address) throws IOException {
                return new TcpConn(new Socket(InetAddress.getLoopbackAddress(), rfcomm));
            }

            @Override
            public void listen(Acceptor onConn) {
                // the phone dials
            }

            @Override
            public void stop() {
                // nothing
            }
        };
        Engine j = Engine.create(c);
        try {
            j.start();
            j.pairManual("127.0.0.1", pcPort, "pc");
            p.getOutputStream().write(("pair " + j.port() + "\n").getBytes(StandardCharsets.UTF_8));
            p.getOutputStream().flush();
            assertTrue(out.readLine().contains("paired"));
            // Wi-Fi off: the PC is reached only over the Bluetooth link.
            Map<String, String> links = new LinkedHashMap<>();
            links.put(pcId, LinkPolicy.BT);
            j.setLinkPolicy(new LinkPolicy(true, false, links));

            assertTrue(j.viaBluetooth(pcId));
            try (Engine.Stream s = j.streamFrom(pcId, "audio?codec=opus")) {
                byte[] all = s.in.readAllBytes();
                assertEquals(20000, all.length);
                assertEquals(7, all[19999]);
            }
        } finally {
            j.stop();
            p.destroy();
            p.waitFor(10, TimeUnit.SECONDS);
        }
    }
}
