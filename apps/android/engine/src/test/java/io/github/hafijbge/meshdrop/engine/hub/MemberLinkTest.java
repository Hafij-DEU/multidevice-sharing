package io.github.hafijbge.meshdrop.engine.hub;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import io.github.hafijbge.meshdrop.engine.Engine;
import io.github.hafijbge.meshdrop.engine.EngineConfig;
import io.github.hafijbge.meshdrop.engine.identity.Identity;
import io.github.hafijbge.meshdrop.engine.identity.PlainKeyVault;
import io.github.hafijbge.meshdrop.engine.links.MemberLinks;
import io.github.hafijbge.meshdrop.engine.recv.DirectorySink;
import io.github.hafijbge.meshdrop.engine.send.PathSource;
import io.github.hafijbge.meshdrop.engine.testutil.NodeListen;
import io.github.hafijbge.meshdrop.engine.testutil.NodeMesh;
import io.github.hafijbge.meshdrop.engine.util.Scrypt;
import java.io.File;
import java.math.BigInteger;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.concurrent.TimeUnit;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

/** M9b: an internet link made on the phone (Java seals it) is served by a Node hub and opened by a Node visitor. */
public class MemberLinkTest {
    @Rule public TemporaryFolder tmp = new TemporaryFolder();

    /** argv: url password → prints {name, size, body} after opening the link like a browser. */
    static final String VISIT = String.join("\n",
            "const { openChunk, openManifest } = await import(process.env.CORE + 'links/crypto.ts');",
            "const [url, password] = process.argv.slice(2);",
            "const u = new URL(url);",
            "const key = Buffer.from(u.hash.slice(3), 'base64url');",
            "const id = u.pathname.split('/')[2];",
            "const api = `${u.origin}/l/${id}/api`;",
            "const o = await fetch(`${api}/open`, { method: 'POST', body: JSON.stringify({ password }) });",
            "if (o.status !== 200) { console.log(JSON.stringify({ status: o.status })); process.exit(0); }",
            "const { session } = await o.json();",
            "const h = { 'x-link-session': session };",
            "const m = openManifest(key, id, Buffer.from(await (await fetch(`${api}/manifest`, { headers: h })).arrayBuffer()));",
            "const parts = [];",
            "const n = Math.max(1, Math.ceil(m.files[0].size / (4 * 1024 * 1024)));",
            "for (let i = 0; i < n; i++) parts.push(openChunk(key, id, 0, i, i === n - 1, Buffer.from(await (await fetch(`${api}/chunk/0/${i}`, { headers: h })).arrayBuffer())));",
            "const body = Buffer.concat(parts);",
            "console.log(JSON.stringify({ name: m.files[0].name, size: body.length, sha: (await import('node:crypto')).createHash('sha256').update(body).digest('hex'), text: m.text ?? null }));");

    static String visit(String url, String password) throws Exception {
        File js = new File(Files.createTempDirectory("visit").toFile(), "visit.mts");
        Files.write(js.toPath(), VISIT.getBytes(StandardCharsets.UTF_8));
        ProcessBuilder pb = new ProcessBuilder("node", js.getPath(), url, password).redirectErrorStream(true);
        pb.environment().put("CORE", new File(System.getProperty("meshdrop.repo"), "packages/core/src").toURI().toString());
        Process p = pb.start();
        assertTrue(p.waitFor(60, TimeUnit.SECONDS));
        return new String(p.getInputStream().readAllBytes(), StandardCharsets.UTF_8).trim();
    }

    @Test
    public void scryptMatchesRfc7914() throws Exception {
        byte[] d = Scrypt.derive("password".getBytes(StandardCharsets.UTF_8), "NaCl".getBytes(StandardCharsets.UTF_8), 1024, 8, 16, 64);
        assertEquals("fdbabe1c9d3472007856e7190d01e9fe7c6ad7cbc8237830e77376634b3731622eaf30d92e22a3886ff109279d9830dac727afb94a83ee6d8360cbdfa2cc0640", String.format("%0128x", new BigInteger(1, d)));
    }

    @Test
    public void aLinkMadeOnThePhoneOpensInABrowser() throws Exception {
        int ingress = RelayHubTest.freePort();
        String hubUrl = "ws://127.0.0.1:" + ingress + "/mesh/v1/hub";
        File hubHome = tmp.newFolder("hub");
        File jHome = tmp.newFolder("phone");
        NodeMesh.hubInit(hubHome);
        Identity jId = Identity.loadOrCreate(jHome, new PlainKeyVault());
        NodeMesh.addMember(hubHome, jId, jHome, "phone", hubUrl);
        EngineConfig c = new EngineConfig(jHome, new PlainKeyVault(), new DirectorySink(new File(jHome, "inbox")));
        c.port = 0;
        c.alias = "phone";
        c.discovery = false;
        c.lanAddrs = Collections::emptyList;
        c.probeDirectoryAddrs = false;
        c.hubBackoffMs = new long[] {50, 200};
        byte[] data = new byte[5 * 1024 * 1024 + 123]; // two chunks
        new java.util.Random(7).nextBytes(data);
        File f = new File(tmp.getRoot(), "photo.jpg");
        Files.write(f.toPath(), data);
        try (NodeListen hub = NodeListen.startWith(hubHome, "--ingress-port", String.valueOf(ingress))) {
            Engine j = Engine.create(c);
            try {
                j.start();
                RelayTest.until("hub link", () -> "main".equals(j.linkedTo()), 15_000);
                MemberLinks.Made m = j.linkCreate(Arrays.asList(PathSource.file(f.toPath())), "hello from the phone", 2 * 3_600_000L, "pw-test-123", 0);
                assertTrue(m.url, m.url.startsWith("http://127.0.0.1:" + ingress + "/l/" + m.id + "#k="));
                String sha = String.format("%064x", new BigInteger(1, java.security.MessageDigest.getInstance("SHA-256").digest(data)));
                assertEquals("{\"name\":\"photo.jpg\",\"size\":" + data.length + ",\"sha\":\"" + sha + "\",\"text\":\"hello from the phone\"}", visit(m.url, "pw-test-123"));
                assertEquals("{\"status\":401}", visit(m.url, "wrong"));
                List<Map<String, Object>> mine = j.linkList();
                assertEquals(1, mine.size());
                assertEquals(m.url, mine.get(0).get("url"));
                j.linkRevoke(m.id);
                assertEquals(0, j.linkList().size());
            } finally {
                j.stop();
            }
        }
    }
}
