package io.github.hafijbge.meshdrop.engine.interop;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import io.github.hafijbge.meshdrop.engine.Engine;
import io.github.hafijbge.meshdrop.engine.EngineConfig;
import io.github.hafijbge.meshdrop.engine.identity.PlainKeyVault;
import io.github.hafijbge.meshdrop.engine.recv.DirectorySink;
import java.io.BufferedReader;
import java.io.File;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.Map;
import java.util.concurrent.TimeUnit;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

/** M10b: the phone plays a PC's sound (GET) and sends its camera (chunked POST) to a Node engine. */
public class StreamInteropTest {
    @Rule public TemporaryFolder tmp = new TemporaryFolder();

    static final String PC = String.join("\n",
            "import * as readline from 'node:readline';",
            "const { Engine } = await import(process.env.CORE + 'engine.ts');",
            "const e = await Engine.create({ home: process.argv[2], inbox: process.argv[2] + '/inbox', port: 0, discovery: false, alias: 'pc', hub: { ingressPort: 0 }, guest: false, localsend: false });",
            "await e.start();",
            "e.setStreamHandler((s) => {",
            "  if (s.method === 'GET' && s.path === 'audio') { s.res.writeHead(200, { 'content-type': 'audio/L16' }); s.res.end(Buffer.alloc(48000, 5)); return true; }",
            "  if (s.method === 'POST' && s.path === 'camera') { let n = 0; s.req.on('data', (c) => (n += c.length)); s.req.on('end', () => { s.res.end('{}'); console.log(JSON.stringify({ got: n })); }); return true; }",
            "  return false;",
            "});",
            "console.log(JSON.stringify({ port: e.port, id: e.identity.deviceId }));",
            "const rl = readline.createInterface({ input: process.stdin });",
            "for await (const line of rl) { const [, p] = line.split(' '); await e.pairManual('127.0.0.1', Number(p), 'phone'); console.log(JSON.stringify({ paired: true })); }");

    @Test
    @SuppressWarnings("unchecked")
    public void playsPcSoundAndSendsTheCamera() throws Exception {
        File dir = tmp.newFolder("script");
        File js = new File(dir, "pc.mts");
        Files.write(js.toPath(), PC.getBytes(StandardCharsets.UTF_8));
        File pcHome = tmp.newFolder("pc");
        ProcessBuilder pb = new ProcessBuilder("node", js.getPath(), pcHome.getPath()).redirectErrorStream(true);
        pb.environment().put("CORE", new File(System.getProperty("meshdrop.repo"), "packages/core/src").toURI().toString());
        Process p = pb.start();
        BufferedReader out = new BufferedReader(new InputStreamReader(p.getInputStream(), StandardCharsets.UTF_8));
        File jHome = tmp.newFolder("phone");
        EngineConfig c = new EngineConfig(jHome, new PlainKeyVault(), new DirectorySink(new File(jHome, "inbox")));
        c.port = 0;
        c.discovery = false;
        c.alias = "phone";
        Engine j = Engine.create(c);
        try {
            Map<String, Object> hello = (Map<String, Object>) io.github.hafijbge.meshdrop.engine.util.Json.parse(out.readLine());
            int pcPort = ((Long) hello.get("port")).intValue();
            String pcId = (String) hello.get("id");
            j.start();
            j.pairManual("127.0.0.1", pcPort, "pc");
            p.getOutputStream().write(("pair " + j.port() + "\n").getBytes(StandardCharsets.UTF_8));
            p.getOutputStream().flush();
            assertTrue(out.readLine().contains("paired"));

            try (Engine.Stream s = j.streamFrom(pcId, "audio")) {
                byte[] all = s.in.readAllBytes();
                assertEquals(48000, all.length);
                assertEquals(5, all[47999]);
            }
            Engine.Stream cam = j.streamTo(pcId, "camera", "multipart/x-mixed-replace");
            OutputStream o = cam.out;
            for (int i = 0; i < 10; i++) o.write(new byte[10_000]);
            o.close();
            assertEquals("{\"got\":100000}", out.readLine());
        } finally {
            j.stop();
            p.destroy();
            p.waitFor(10, TimeUnit.SECONDS);
        }
    }
}
