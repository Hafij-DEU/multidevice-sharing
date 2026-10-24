package io.github.hafijbge.meshdrop.engine.send;

import io.github.hafijbge.meshdrop.engine.identity.Identity;
import io.github.hafijbge.meshdrop.engine.net.Http;
import io.github.hafijbge.meshdrop.engine.net.Tls;
import java.io.IOException;
import java.net.Socket;
import java.security.cert.CertificateException;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Set;
import java.util.function.BooleanSupplier;
import javax.net.ssl.SSLHandshakeException;
import javax.net.ssl.SSLSocket;

/** One request per pinned mutual-TLS connection to the target's LAN address (protocol v1 M1 path). */
public final class LanTransport implements Transport {
    private final Identity me;
    private final Sender.Target t;
    private final int connectTimeoutMs;

    public LanTransport(Identity me, Sender.Target t, int connectTimeoutMs) {
        this.me = me;
        this.t = t;
        this.connectTimeoutMs = connectTimeoutMs;
    }

    @Override
    public String kind() {
        return "lan";
    }

    @Override
    public Http.Response request(String method, String path, byte[] body, String contentType, int timeoutMs, Set<Socket> track, BooleanSupplier aborted)
            throws IOException {
        if (t.host == null || t.port <= 0) throw new NoRoute();
        SSLSocket s;
        try {
            s = Tls.connect(Tls.pinnedClient(me, t.deviceId), t.host, t.port, connectTimeoutMs);
        } catch (SSLHandshakeException e) {
            for (Throwable c = e; c != null; c = c.getCause()) {
                if (c instanceof CertificateException && String.valueOf(c.getMessage()).contains("pin-mismatch")) throw new Sender.PinMismatch();
            }
            throw e;
        }
        if (track != null) track.add(s);
        try {
            s.setSoTimeout(timeoutMs);
            Map<String, String> h = new LinkedHashMap<>();
            if (contentType != null) h.put("Content-Type", contentType);
            try {
                return Http.request(s, method, path, h, body, Sender.MAX_REPLY);
            } catch (Http.BodyTooLarge e) {
                throw new Sender.Protocol("reply too large"); // a malformed reply is permanent (protocol: Sender algorithm step 6)
            }
        } finally {
            if (track != null) track.remove(s);
            Sender.closeQuietly(s);
        }
    }
}
