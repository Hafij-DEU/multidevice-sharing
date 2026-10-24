package io.github.hafijbge.meshdrop.engine.proto;

import io.github.hafijbge.meshdrop.engine.crypto.Hpke;
import io.github.hafijbge.meshdrop.engine.util.B64;
import io.github.hafijbge.meshdrop.engine.util.Json;
import java.nio.charset.StandardCharsets;
import java.security.KeyPair;
import java.security.PublicKey;
import java.security.SecureRandom;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.regex.Pattern;
import javax.crypto.AEADBadTagException;

/** The Offer (body of POST offer): creation on the sender, every receiver check on the receiver. */
public final class Offer {
    public static final Pattern SESSION_ID = Pattern.compile("^[A-Za-z0-9_-]{22}$");
    private static final SecureRandom RNG = new SecureRandom();

    public final String sessionId;
    public final String from;
    public final String to;
    public final String enc;
    public final String sealedManifest;

    public Offer(String sessionId, String from, String to, String enc, String sealedManifest) {
        this.sessionId = sessionId;
        this.from = from;
        this.to = to;
        this.enc = enc;
        this.sealedManifest = sealedManifest;
    }

    /** A refused offer, with the HTTP status and error code the receiver answers. */
    public static final class BadOffer extends RuntimeException {
        public final int status;
        public final String code;

        public BadOffer(int status, String code, String detail) {
            super(code + ": " + detail);
            this.status = status;
            this.code = code;
        }

        static BadOffer badOffer(String detail) {
            return new BadOffer(422, "bad-offer", detail);
        }
    }

    public static final class Created {
        public final Offer offer;
        public final Hpke.Context ctx;

        Created(Offer offer, Hpke.Context ctx) {
            this.offer = offer;
            this.ctx = ctx;
        }
    }

    public static final class Opened {
        public final Manifest manifest;
        public final Hpke.Context ctx;

        Opened(Manifest manifest, Hpke.Context ctx) {
            this.manifest = manifest;
            this.ctx = ctx;
        }
    }

    public static String newSessionId() {
        byte[] b = new byte[16];
        RNG.nextBytes(b);
        return B64.url(b);
    }

    public String toJson() {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("v", 1L);
        m.put("sessionId", sessionId);
        m.put("from", from);
        m.put("to", to);
        m.put("enc", enc);
        m.put("sealedManifest", sealedManifest);
        return Json.stringify(m);
    }

    /** Sender: a fresh HPKE context for (session, target) and the sealed manifest. `ephemeral` null = random. */
    public static Created create(KeyPair sender, String senderId, PublicKey receiverPub, Manifest m, KeyPair ephemeral) {
        if (!senderId.equals(m.from)) throw new IllegalArgumentException("manifest.from does not match the sender");
        Manifest.fromJson(Json.parse(m.toJson())); // validate the shape before sealing
        Hpke.Sender s = Hpke.setupAuthS(receiverPub, Chunks.info(m.sessionId), sender, ephemeral);
        byte[] sealed = s.ctx.seal(0, Chunks.manifestAad(m.sessionId), m.toJson().getBytes(StandardCharsets.UTF_8));
        return new Created(new Offer(m.sessionId, m.from, m.to, B64.std(s.enc), B64.std(sealed)), s.ctx);
    }

    /**
     * Receiver: parses and opens an offer from TLS peer `peerId`. `trustedSenderKey` must come from
     * the trust store. Status split as in docs/protocol.md: 400 bad-json, 403 forbidden (from is not
     * the peer, checked right after parsing), 422 bad-offer for everything else.
     */
    @SuppressWarnings("unchecked")
    public static Opened open(byte[] json, KeyPair receiver, String receiverId, String peerId, PublicKey trustedSenderKey) {
        Object x;
        try {
            x = Json.parse(new String(json, StandardCharsets.UTF_8));
        } catch (Json.JsonException e) {
            throw new BadOffer(400, "bad-json", e.getMessage());
        }
        if (!(x instanceof Map)) throw BadOffer.badOffer("not an object");
        Map<String, Object> o = (Map<String, Object>) x;
        if (!peerId.equals(o.get("from"))) throw new BadOffer(403, "forbidden", "offer.from is not the peer");
        Object sid = o.get("sessionId");
        if (!(sid instanceof String) || !SESSION_ID.matcher((String) sid).matches()) throw BadOffer.badOffer("sessionId");
        if (!Long.valueOf(1).equals(o.get("v")) || !(o.get("to") instanceof String) || !(o.get("enc") instanceof String)
                || !(o.get("sealedManifest") instanceof String)) {
            throw BadOffer.badOffer("invalid offer");
        }
        if (!receiverId.equals(o.get("to"))) throw BadOffer.badOffer("not addressed to this device");
        String sessionId = (String) sid;
        Hpke.Context ctx;
        Manifest m;
        try {
            ctx = Hpke.setupAuthR(B64.stdDecode((String) o.get("enc")), receiver, Chunks.info(sessionId), trustedSenderKey);
            byte[] pt = ctx.open(0, Chunks.manifestAad(sessionId), B64.stdDecode((String) o.get("sealedManifest")));
            m = Manifest.parse(pt);
        } catch (IllegalArgumentException | AEADBadTagException e) {
            throw BadOffer.badOffer("cannot open: " + e.getMessage());
        }
        if (!m.sessionId.equals(sessionId)) throw BadOffer.badOffer("manifest sessionId");
        if (!m.from.equals(peerId)) throw BadOffer.badOffer("manifest from");
        if (!m.to.equals(receiverId)) throw BadOffer.badOffer("manifest to");
        return new Opened(m, ctx);
    }
}
