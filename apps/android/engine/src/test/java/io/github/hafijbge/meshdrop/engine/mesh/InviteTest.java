package io.github.hafijbge.meshdrop.engine.mesh;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertThrows;

import io.github.hafijbge.meshdrop.engine.util.Hex;
import io.github.hafijbge.meshdrop.engine.util.Io;
import io.github.hafijbge.meshdrop.engine.util.Json;
import java.nio.file.Paths;
import java.util.Arrays;
import java.util.List;
import java.util.Map;
import org.junit.Test;

public class InviteTest {
    @SuppressWarnings("unchecked")
    static Map<String, Object> vector() throws Exception {
        return (Map<String, Object>) Json.parse(Io.readString(Paths.get(System.getProperty("meshdrop.repo"), "protocol/vectors/invite-v1.json")));
    }

    @Test
    @SuppressWarnings("unchecked")
    public void theVectorParsesFormatsAndProves() throws Exception {
        Map<String, Object> v = vector();
        Map<String, Object> want = (Map<String, Object>) v.get("invite");
        Invite i = Invite.parse((String) v.get("uri"));
        assertArrayEquals(Hex.parse((String) want.get("secretHex")), i.secret);
        assertEquals(want.get("inviter"), i.inviter);
        assertEquals(want.get("mesh"), i.mesh);
        assertEquals(1, i.lan.size());
        assertEquals("192.168.1.20", i.lan.get(0).host);
        assertEquals(53318, i.lan.get(0).port);
        assertEquals(want.get("hubUrls"), i.hubUrls);
        assertEquals(want.get("expiresAt"), i.expiresAt);
        assertEquals(v.get("uri"), i.uri());
        assertEquals(v.get("proofB64"), Invite.proof(i.secret, (String) v.get("newDeviceId"), i.inviter));
    }

    @Test
    public void ipv6AndLoopbackWsRoundTrip() {
        String id = "1111111111111111111111111111111111111111111111111111111111111111";
        String u = "meshdrop://join?v=1&s=AAECAwQFBgcICQoLDA0ODw&i=" + id + "&r=" + id + "&l=%5Bfe80%3A%3A1%5D%3A53318&h=ws%3A%2F%2F127.0.0.1%3A9%2Fmesh%2Fv1%2Fhub&e=5";
        Invite i = Invite.parse(u);
        assertEquals("fe80::1", i.lan.get(0).host);
        assertEquals(Arrays.asList("ws://127.0.0.1:9/mesh/v1/hub"), i.hubUrls);
        assertEquals(u, i.uri());
    }

    @Test
    public void malformedInvitesAreRefused() throws Exception {
        String uri = (String) vector().get("uri");
        String id = "1111111111111111111111111111111111111111111111111111111111111111";
        List<String> bad = Arrays.asList(
                uri.replace("meshdrop://join?", "meshdrop://pair?"),
                uri.replace("v=1&", "v=2&"),
                uri.replace("&e=1790000000", ""),
                uri.replace("v=1&s=AAECAwQFBgcICQoLDA0ODw&", "s=AAECAwQFBgcICQoLDA0ODw&v=1&"),
                uri.replace("s=AAECAwQFBgcICQoLDA0ODw", "s=AAEC"),
                uri.replace("i=1111", "i=X111"),
                uri.replace("&e=1790000000", "&e=1790000000&x=1"),
                uri.replace("wss%3A%2F%2Fhub", "ws%3A%2F%2Fhub"),
                uri.replace("192.168.1.20%3A53318", "192.168.1.20%3A0"),
                uri.replace("192.168.1.20%3A53318", "%zz"),
                uri.replace("&e=1790000000", "&e=1790000000&e=1"),
                "meshdrop://join?v=1&s=AAECAwQFBgcICQoLDA0ODw&i=" + id + "&r=" + id + "&e=1");
        for (String b : bad) assertThrows(b, Invite.InviteError.class, () -> Invite.parse(b));
    }
}
