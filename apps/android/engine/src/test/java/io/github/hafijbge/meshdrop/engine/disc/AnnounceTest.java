package io.github.hafijbge.meshdrop.engine.disc;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;

import java.nio.charset.StandardCharsets;
import org.junit.Test;

/** The strict announce validation of packages/core/src/discovery.ts. */
public class AnnounceTest {
    static final String ID = "ab".repeat(32);

    static Announce.Peer parse(String json) {
        byte[] b = json.getBytes(StandardCharsets.UTF_8);
        return Announce.parse(b, b.length, "192.168.1.9");
    }

    @Test
    public void aValidPacketParsesWithTheSourceAddressAsHost() {
        Announce.Peer p = parse("{\"v\":1,\"deviceId\":\"" + ID + "\",\"alias\":\"pc\",\"deviceType\":\"desktop\",\"port\":53318,\"extra\":1,\"host\":\"6.6.6.6\"}");
        assertEquals(ID, p.deviceId);
        assertEquals("192.168.1.9", p.host);
        assertEquals(53318, p.port);
        assertEquals("desktop", p.deviceType);
    }

    @Test
    public void everythingElseIsDropped() {
        String ok = "\"deviceId\":\"" + ID + "\",\"alias\":\"pc\",\"deviceType\":\"desktop\",\"port\":53318";
        for (String bad : new String[] {
            "nope", "[1]", "null", "{\"v\":2," + ok + "}", "{" + ok + "}",
            "{\"v\":1," + ok.replace(ID, "AB".repeat(32)) + "}",
            "{\"v\":1," + ok.replace(ID, "ab") + "}",
            "{\"v\":1," + ok.replace("\"pc\"", "\"" + "x".repeat(65) + "\"") + "}",
            "{\"v\":1," + ok.replace("\"pc\"", "7") + "}",
            "{\"v\":1," + ok.replace("desktop", "toaster") + "}",
            "{\"v\":1," + ok.replace("53318", "0") + "}",
            "{\"v\":1," + ok.replace("53318", "70000") + "}",
            "{\"v\":1," + ok.replace("53318", "1.5") + "}",
            "{\"v\":1," + ok + ",\"pad\":\"" + "x".repeat(1100) + "\"}",
        }) {
            assertNull(bad.length() > 60 ? bad.substring(0, 60) : bad, parse(bad));
        }
    }

    @Test
    public void encodesTheSelfAnnounce() {
        String s = new String(Announce.encode(ID, "phone", "mobile", 4000), StandardCharsets.UTF_8);
        assertEquals("{\"v\":1,\"deviceId\":\"" + ID + "\",\"alias\":\"phone\",\"deviceType\":\"mobile\",\"port\":4000}", s);
    }
}
