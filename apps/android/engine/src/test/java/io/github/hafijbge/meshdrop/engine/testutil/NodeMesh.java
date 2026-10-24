package io.github.hafijbge.meshdrop.engine.testutil;

import static org.junit.Assert.assertEquals;

import io.github.hafijbge.meshdrop.engine.identity.Identity;
import io.github.hafijbge.meshdrop.engine.mesh.MembershipStore;
import io.github.hafijbge.meshdrop.engine.net.TrustStore;
import io.github.hafijbge.meshdrop.engine.util.Json;
import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Map;
import java.util.concurrent.TimeUnit;

/** Node-side mesh fixtures: a hub home (`hub init`) and members signed in without a join. */
public final class NodeMesh {
    static final String CORE = new File(System.getProperty("meshdrop.repo"), "packages/core/src").toURI().toString();

    /** argv: hubHome deviceId alias pemFile → prints {signed, anchorPem}. */
    static final String ADD_MEMBER = String.join("\n",
            "import { createPublicKey } from 'node:crypto';",
            "import { readFileSync } from 'node:fs';",
            "const { loadOrCreateRootKey } = await import(process.env.CORE + 'mesh/rootkey.ts');",
            "const { MembershipStore } = await import(process.env.CORE + 'mesh/members.ts');",
            "const { signList } = await import(process.env.CORE + 'mesh/membership.ts');",
            "const [home, deviceId, alias, pemFile] = process.argv.slice(2);",
            "const root = await loadOrCreateRootKey(home);",
            "const store = await MembershipStore.load(home);",
            "const cur = store.list();",
            "const now = Date.now();",
            "const next = { ...cur, version: cur.version + 1, issuedAt: now,",
            "  members: [...cur.members, { deviceId, alias, publicKeyPem: readFileSync(pemFile, 'utf8'), role: 'member', addedAt: now }] };",
            "if (process.env.URLS) next.hub = { ...cur.hub, urls: JSON.parse(process.env.URLS) };",
            "const s = signList(next, root);",
            "store.accept(s);",
            "console.log(JSON.stringify({ signed: s, anchorPem: createPublicKey(root).export({ type: 'spki', format: 'pem' }) }));");

    private NodeMesh() {}

    /** `hub init` on `home` (alias "hub") with these hub URLs. */
    public static void hubInit(File home, String... urls) throws Exception {
        List<String> a = new ArrayList<>(Arrays.asList("hub", "init", "--home", home.getPath(), "--alias", "hub"));
        for (String u : urls) {
            a.add("--url");
            a.add(u);
        }
        Node.Result r = Node.run(a.toArray(new String[0]));
        assertEquals(r.out, 0, r.code);
    }

    /**
     * Signs `id` into the hub's list (the hub must not be running) and gives it the same mesh state.
     * `hubUrls`, if any, replace the list's hub URLs (the CLI refuses ws:// loopback ones).
     */
    public static MembershipStore addMember(File hubHome, Identity id, File memberHome, String alias, String... hubUrls) throws Exception {
        return addMember(hubHome, id.deviceId(), id.keyPair().getPublic(), memberHome, alias, hubUrls);
    }

    /** A Node device (its identity under `home`) signed into the hub's list, with the same mesh state. */
    public static String addNodeMember(File hubHome, File home, String alias, String... hubUrls) throws Exception {
        Node.Result r = Node.run("id", "--home", home.getPath());
        assertEquals(r.out, 0, r.code);
        byte[] der = Files.readAllBytes(new File(home, "identity/cert.der").toPath());
        String id = Identity.deviceIdOf(der);
        addMember(hubHome, id, io.github.hafijbge.meshdrop.engine.identity.X509.publicKey(der), home, alias, hubUrls);
        return id;
    }

    @SuppressWarnings("unchecked")
    public static MembershipStore addMember(File hubHome, String deviceId, java.security.PublicKey key, File memberHome, String alias, String... hubUrls) throws Exception {
        File dir = Files.createTempDirectory("nodemesh").toFile();
        File js = new File(dir, "add.mts");
        File pem = new File(dir, "key.pem");
        Files.write(js.toPath(), ADD_MEMBER.getBytes(StandardCharsets.UTF_8));
        Files.write(pem.toPath(), TrustStore.pem(key).getBytes(StandardCharsets.UTF_8));
        ProcessBuilder pb = new ProcessBuilder("node", js.getPath(), hubHome.getPath(), deviceId, alias, pem.getPath()).redirectErrorStream(true);
        pb.environment().put("CORE", CORE);
        if (hubUrls.length > 0) pb.environment().put("URLS", Json.stringify(java.util.Arrays.asList((Object[]) hubUrls)));
        Process p = pb.start();
        if (!p.waitFor(60, TimeUnit.SECONDS)) {
            p.destroyForcibly();
            throw new IOException("add member timed out");
        }
        String out = new String(p.getInputStream().readAllBytes(), StandardCharsets.UTF_8);
        assertEquals(out, 0, p.exitValue());
        Map<String, Object> r = (Map<String, Object>) Json.parse(out.trim());
        if (memberHome == null) return null;
        return MembershipStore.init(memberHome, MembershipStore.parseAnchor((String) r.get("anchorPem")), (Map<String, Object>) r.get("signed"));
    }
}
