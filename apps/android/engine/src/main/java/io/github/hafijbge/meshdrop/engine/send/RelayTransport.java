package io.github.hafijbge.meshdrop.engine.send;

import io.github.hafijbge.meshdrop.engine.hub.HubClient;
import io.github.hafijbge.meshdrop.engine.identity.Identity;
import io.github.hafijbge.meshdrop.engine.mesh.Envelope;
import io.github.hafijbge.meshdrop.engine.net.Http;
import io.github.hafijbge.meshdrop.engine.util.B64;
import io.github.hafijbge.meshdrop.engine.util.Json;
import java.io.IOException;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.security.PublicKey;
import java.security.SecureRandom;
import java.util.Arrays;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;
import java.util.function.BooleanSupplier;
import java.util.function.Function;

/**
 * Requests as signed envelopes through the hub link (transfer/transport.ts RelayTransport). In
 * "held" mode the offer carries holdBytes, so an offline target's session is stored on the hub; the
 * hub's own 2xx replies are then accepted (signed by the hub) as well as the target's.
 */
public final class RelayTransport implements Transport {
    private static final Set<Integer> HUB_ERRORS = new HashSet<>(Arrays.asList(400, 500, 503, 504, 507));
    private static final SecureRandom RANDOM = new SecureRandom();

    /** The relay answered with something that is not a valid answer for this request. */
    public static final class RelayReply extends Sender.Protocol {
        RelayReply(String m) {
            super(m);
        }
    }

    private final Identity me;
    private final HubClient hub;
    private final String to;
    private final Function<String, PublicKey> pubOf;
    private final String mode;
    private final long holdBytes;
    /** A "relay" transport whose session turned out to be held on the hub (an interrupted held upload). */
    private volatile boolean latched;

    public RelayTransport(Identity me, HubClient hub, String to, Function<String, PublicKey> pubOf, String mode, long holdBytes) {
        if (!mode.equals("relay") && !mode.equals("held")) throw new IllegalArgumentException("mode");
        if (mode.equals("held") && holdBytes < 0) throw new IllegalArgumentException("held mode needs holdBytes");
        this.me = me;
        this.hub = hub;
        this.to = to;
        this.pubOf = pubOf;
        this.mode = mode;
        this.holdBytes = holdBytes;
    }

    @Override
    public String kind() {
        return latched ? "held" : mode;
    }

    @Override
    public Http.Response request(String method, String path, byte[] body, String contentType, int timeoutMs, Set<Socket> track, BooleanSupplier aborted)
            throws IOException {
        byte[] id = new byte[16];
        RANDOM.nextBytes(id);
        Envelope.Header h = Envelope.Header.req(B64.url(id), me.deviceId(), to, method, path);
        h.contentType = contentType;
        boolean isOffer = method.equals("POST") && path.equals("/mesh/v1/offer");
        if (kind().equals("held") && isOffer) h.holdBytes = holdBytes;
        Envelope req = Envelope.seal(h, body == null ? new byte[0] : body, me.keyPair().getPrivate());
        Envelope res = hub.request(req, timeoutMs, aborted);
        return check(res, req.header.id, isOffer);
    }

    private Http.Response check(Envelope res, String id, boolean isOffer) throws IOException {
        // The hub this link is on: the main hub, or a relay hub (M9) while the main one is away.
        String hubId = hub.linkedHub() != null ? hub.linkedHub() : hub.hubDeviceId();
        try {
            Envelope.open(res, pubOf);
        } catch (Envelope.EnvelopeError e) {
            throw new RelayReply("relay reply does not verify");
        }
        Envelope.Header r = res.header;
        if (!r.kind.equals("res") || !r.id.equals(id) || !r.to.equals(me.deviceId())) throw new RelayReply("relay reply for another request");
        int status = r.status;
        if (!r.from.equals(to)) {
            // The hub may only answer for the target with its own errors, or (held mode) held replies.
            boolean allowed = r.from.equals(hubId)
                    && (HUB_ERRORS.contains(status) || (kind().equals("held") && ((status >= 200 && status < 300) || status == 403 || status == 409)));
            if (!allowed && r.from.equals(hubId) && mode.equals("relay") && isOffer && status == 200 && isHeldBody(res.body)) {
                // Resuming an upload the hub already holds for an offline target: continue it as held.
                latched = true;
                allowed = true;
            }
            if (!allowed) throw new RelayReply("relay reply from an unexpected device");
        }
        if (r.contentType != null && r.contentType.toLowerCase(java.util.Locale.ROOT).matches("^application/json\\s*(;.*)?$") && res.body.length > 0) {
            try {
                Json.parse(new String(res.body, StandardCharsets.UTF_8));
            } catch (RuntimeException e) {
                throw new RelayReply("invalid JSON in application/json response");
            }
        }
        if (res.body.length > Sender.MAX_REPLY) throw new RelayReply("reply too large");
        Http.Response out = new Http.Response();
        out.status = status;
        out.body = res.body;
        if (r.contentType != null) out.headers.put("content-type", r.contentType);
        return out;
    }

    static boolean isHeldBody(byte[] b) {
        try {
            Object j = Json.parse(new String(b, StandardCharsets.UTF_8));
            return j instanceof Map && Boolean.TRUE.equals(((Map<?, ?>) j).get("held"));
        } catch (RuntimeException e) {
            return false;
        }
    }
}
