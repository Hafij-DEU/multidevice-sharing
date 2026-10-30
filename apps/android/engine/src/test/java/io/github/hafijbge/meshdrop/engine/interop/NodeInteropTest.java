package io.github.hafijbge.meshdrop.engine.interop;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import io.github.hafijbge.meshdrop.engine.testutil.Node;
import io.github.hafijbge.meshdrop.engine.testutil.Peers;
import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.Map;
import java.util.Random;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

/** The Java engine against the real Node engine (packages/core/src/cli.ts). */
public class NodeInteropTest {
    @Rule public TemporaryFolder tmp = new TemporaryFolder();

    @Test
    public void receivesFromNode() throws Exception {
        try (Peers.Receiver phone = Peers.receiver(tmp.newFolder("phone"))) {
            File node = tmp.newFolder("node");
            Node.Result paired = Node.run("pair", "127.0.0.1:" + phone.port, "phone", "--home", node.getPath());
            assertEquals(paired.out, 0, paired.code);
            phone.trustHome(node, "pc");

            File src = tmp.newFolder("src");
            File folder = new File(src, "trip");
            assertTrue(new File(folder, "empty/inner").mkdirs());
            Files.write(new File(folder, "ü 😀.txt").toPath(), "hej".getBytes(StandardCharsets.UTF_8));
            byte[] big = new byte[9 * 1024 * 1024 + 7];
            new Random(42).nextBytes(big);
            Files.write(new File(folder, "big.bin").toPath(), big);

            Node.Result sent = Node.run(120, "send", phone.id.deviceId().substring(0, 8), folder.getPath(), "--text", "hi", "--home", node.getPath());
            assertEquals(sent.out, 0, sent.code);
            assertArrayEquals(big, Files.readAllBytes(new File(phone.inboxDir, "trip/big.bin").toPath()));
            assertEquals("hej", Files.readString(new File(phone.inboxDir, "trip/ü 😀.txt").toPath()));
            assertTrue(new File(phone.inboxDir, "trip/empty/inner").isDirectory());
            Map<String, Object> received = null;
            synchronized (phone.events) {
                for (Map<String, Object> e : phone.events) if ("received".equals(e.get("type"))) received = e;
            }
            assertTrue(received != null);
            assertEquals("hi", received.get("text"));

            File single = new File(src, "ü 😀.txt");
            Files.write(single.toPath(), "again".getBytes(StandardCharsets.UTF_8));
            for (int i = 0; i < 2; i++) assertEquals(0, Node.run("send", phone.id.deviceId().substring(0, 8), single.getPath(), "--home", node.getPath()).code);
            assertEquals("again", Files.readString(new File(phone.inboxDir, "ü 😀.txt").toPath()));
            assertEquals("again", Files.readString(new File(phone.inboxDir, "ü 😀 (1).txt").toPath()));
        }
    }
}
