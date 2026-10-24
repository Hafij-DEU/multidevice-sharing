package io.github.hafijbge.meshdrop.engine.proto;

import io.github.hafijbge.meshdrop.engine.crypto.Hpke;
import io.github.hafijbge.meshdrop.engine.util.B64;
import io.github.hafijbge.meshdrop.engine.util.Json;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.Map;
import javax.crypto.AEADBadTagException;

/** Chunk layout and sealing (docs/protocol.md "HPKE suite and chunk sealing"). */
public final class Chunks {
    public static final int CHUNK_SIZE = 4_194_304;
    public static final int TAG = 16;

    private Chunks() {}

    public static long count(long size) {
        if (size < 0) throw new IllegalArgumentException("size");
        return (size + CHUNK_SIZE - 1) / CHUNK_SIZE;
    }

    public static long seq(long fileId, long index) {
        if (fileId < 0 || fileId > 0xffffffffL || index < 0 || index > 0xffffffffL) throw new IllegalArgumentException("u32");
        return ((fileId + 1) << 32) | index;
    }

    public static byte[] info(String sessionId) {
        return ("meshdrop/v1 " + sessionId).getBytes(StandardCharsets.UTF_8);
    }

    public static byte[] manifestAad(String sessionId) {
        return sessionId.getBytes(StandardCharsets.UTF_8);
    }

    public static byte[] aad(String sessionId, long fileId, long index) {
        byte[] sid = sessionId.getBytes(StandardCharsets.UTF_8);
        return ByteBuffer.allocate(sid.length + 8).put(sid).putInt((int) fileId).putInt((int) index).array();
    }

    public static byte[] seal(Hpke.Context ctx, String sessionId, long fileId, long index, byte[] plain) {
        if (plain.length > CHUNK_SIZE) throw new IllegalArgumentException("chunk too large");
        return ctx.seal(seq(fileId, index), aad(sessionId, fileId, index), plain);
    }

    public static byte[] open(Hpke.Context ctx, String sessionId, long fileId, long index, byte[] sealed) throws AEADBadTagException {
        return ctx.open(seq(fileId, index), aad(sessionId, fileId, index), sealed);
    }

    /** Context secrets as JSON (kept in session state so a restart can resume). Same shape as the Node engine. */
    public static String exportCtx(Hpke.Context ctx) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("aead", ctx.aead() == Hpke.Aead.AES_256_GCM ? "aes-256-gcm" : "aes-128-gcm");
        m.put("key", B64.std(ctx.key()));
        m.put("baseNonce", B64.std(ctx.baseNonce()));
        m.put("exporterSecret", B64.std(ctx.exporterSecret()));
        return Json.stringify(m);
    }

    @SuppressWarnings("unchecked")
    public static Hpke.Context importCtx(String s) {
        Object o = Json.parse(s);
        if (!(o instanceof Map)) throw new IllegalArgumentException("invalid ctx");
        Map<String, Object> m = (Map<String, Object>) o;
        Hpke.Aead aead;
        if ("aes-256-gcm".equals(m.get("aead"))) aead = Hpke.Aead.AES_256_GCM;
        else if ("aes-128-gcm".equals(m.get("aead"))) aead = Hpke.Aead.AES_128_GCM;
        else throw new IllegalArgumentException("invalid ctx: aead");
        byte[] key = B64.stdDecode((String) m.get("key"));
        byte[] nonce = B64.stdDecode((String) m.get("baseNonce"));
        byte[] exp = B64.stdDecode((String) m.get("exporterSecret"));
        if (key.length != (aead == Hpke.Aead.AES_256_GCM ? 32 : 16) || nonce.length != 12 || exp.length != 32) {
            throw new IllegalArgumentException("invalid ctx");
        }
        return new Hpke.Context(key, nonce, exp, aead);
    }
}
