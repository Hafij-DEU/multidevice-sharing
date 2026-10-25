package io.github.hafijbge.meshdrop.engine.links;

import io.github.hafijbge.meshdrop.engine.net.Http;
import io.github.hafijbge.meshdrop.engine.send.Source;
import io.github.hafijbge.meshdrop.engine.send.Transport;
import io.github.hafijbge.meshdrop.engine.util.B64;
import io.github.hafijbge.meshdrop.engine.util.Json;
import io.github.hafijbge.meshdrop.engine.util.Scrypt;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.channels.SeekableByteChannel;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import javax.crypto.Cipher;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;

/**
 * Internet links made on this device (M9b), same format as packages/core/src/links/crypto.ts: files are
 * sealed here in 4 MiB AES-256-GCM chunks under a key that exists only in the link's #k= fragment, and
 * only the ciphertext goes to the hub (main or relay) over the hub link, at /mesh/v1/links.
 */
public final class MemberLinks {
    public static final String DOMAIN = "meshdrop-link-v1";
    public static final int CHUNK = 4 * 1024 * 1024;
    public static final long MANIFEST_FILE = 0xffffffffL;
    /** Sealed bytes per upload request. */
    static final int SLICE = 1024 * 1024;
    private static final SecureRandom RANDOM = new SecureRandom();

    private MemberLinks() {}

    public static final class Made {
        public final String id;
        public final String url;
        public final long expiresAt;

        Made(String id, String url, long expiresAt) {
            this.id = id;
            this.url = url;
            this.expiresAt = expiresAt;
        }
    }

    static long chunkCount(long size) {
        return Math.max(1, (size + CHUNK - 1) / CHUNK);
    }

    static long sealedSize(long size) {
        return size + 16 * chunkCount(size);
    }

    static byte[] nonce(long fileIdx, long chunkIdx) {
        return ByteBuffer.allocate(12).putInt((int) fileIdx).putLong(chunkIdx).array();
    }

    static byte[] aad(String linkId, long fileIdx, long chunkIdx, boolean last) {
        byte[] d = DOMAIN.getBytes(StandardCharsets.UTF_8);
        byte[] id = linkId.getBytes(StandardCharsets.UTF_8);
        return ByteBuffer.allocate(d.length + 1 + id.length + 1 + 13).put(d).put((byte) 0).put(id).put((byte) 0)
                .putInt((int) fileIdx).putLong(chunkIdx).put((byte) (last ? 1 : 0)).array();
    }

    public static byte[] sealChunk(byte[] key, String linkId, long fileIdx, long chunkIdx, boolean last, byte[] plain, int len) throws GeneralSecurityException {
        Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
        c.init(Cipher.ENCRYPT_MODE, new SecretKeySpec(key, "AES"), new GCMParameterSpec(128, nonce(fileIdx, chunkIdx)));
        c.updateAAD(aad(linkId, fileIdx, chunkIdx, last));
        return c.doFinal(plain, 0, len);
    }

    static String hex(byte[] b) {
        StringBuilder s = new StringBuilder();
        for (byte x : b) s.append(String.format("%02x", x));
        return s.toString();
    }

    private static Map<String, Object> call(Transport t, String method, String path, byte[] body, String type, int want) throws IOException {
        Http.Response r = t.request(method, path, body, type, 120_000, null, null);
        Object j = null;
        try {
            j = r.body.length == 0 ? null : Json.parse(r.text());
        } catch (RuntimeException ignored) {
            // not JSON
        }
        @SuppressWarnings("unchecked")
        Map<String, Object> m = j instanceof Map ? (Map<String, Object>) j : new LinkedHashMap<>();
        if (r.status != want) throw new IOException("The hub refused the link (" + (m.get("error") instanceof String ? m.get("error") : r.status) + ").");
        return m;
    }

    /**
     * Seals `files` (and `text`) and uploads them to the hub `t` points at. `expiresInMs` 1 h .. 30 days;
     * `password` (may be null) is sent only as an scrypt record; `maxDownloads` 0: any.
     */
    public static Made create(Transport t, List<Source> files, String text, long expiresInMs, String password, int maxDownloads) throws IOException {
        try {
            byte[] idb = new byte[16];
            RANDOM.nextBytes(idb);
            String id = B64.url(idb);
            byte[] key = new byte[32];
            RANDOM.nextBytes(key);
            List<Object> mf = new ArrayList<>();
            List<Object> sizes = new ArrayList<>();
            long[] lens = new long[files.size()];
            for (int i = 0; i < files.size(); i++) {
                lens[i] = files.get(i).size();
                Map<String, Object> f = new LinkedHashMap<>();
                f.put("name", files.get(i).name());
                f.put("size", lens[i]);
                mf.add(f);
                Map<String, Object> s = new LinkedHashMap<>();
                s.put("size", lens[i]);
                sizes.add(s);
            }
            Map<String, Object> manifest = new LinkedHashMap<>();
            manifest.put("v", 1L);
            manifest.put("files", mf);
            if (text != null && !text.isEmpty()) manifest.put("text", text);
            byte[] mplain = Json.stringify(manifest).getBytes(StandardCharsets.UTF_8);
            Map<String, Object> begin = new LinkedHashMap<>();
            begin.put("id", id);
            begin.put("keyHash", hex(MessageDigest.getInstance("SHA-256").digest(key)));
            begin.put("label", files.isEmpty() ? "message" : files.get(0).name() + (files.size() > 1 ? " +" + (files.size() - 1) : ""));
            begin.put("expiresInMs", expiresInMs);
            begin.put("files", sizes);
            begin.put("manifest", B64.std(sealChunk(key, id, MANIFEST_FILE, 0, true, mplain, mplain.length)));
            if (password != null && !password.isEmpty()) {
                byte[] salt = new byte[16];
                RANDOM.nextBytes(salt);
                Map<String, Object> pw = new LinkedHashMap<>();
                pw.put("salt", B64.std(salt));
                pw.put("hash", B64.std(Scrypt.derive(password.getBytes(StandardCharsets.UTF_8), salt, 1 << 15, 8, 1, 32)));
                begin.put("password", pw);
            }
            if (maxDownloads > 0) begin.put("maxDownloads", (long) maxDownloads);
            call(t, "POST", "/mesh/v1/links", Json.stringify(begin).getBytes(StandardCharsets.UTF_8), "application/json", 201);

            byte[] plain = new byte[CHUNK];
            for (int i = 0; i < files.size(); i++) {
                long n = chunkCount(lens[i]);
                long offset = 0;
                try (SeekableByteChannel ch = files.get(i).open()) {
                    for (long c = 0; c < n; c++) {
                        int want = (int) Math.min(CHUNK, lens[i] - c * CHUNK);
                        ByteBuffer bb = ByteBuffer.wrap(plain, 0, want);
                        while (bb.hasRemaining()) if (ch.read(bb) < 0) throw new IOException("the file changed while sealing");
                        byte[] sealed = sealChunk(key, id, i, c, c == n - 1, plain, want);
                        for (int p = 0; p < sealed.length; p += SLICE) {
                            int len = Math.min(SLICE, sealed.length - p);
                            byte[] part = new byte[len];
                            System.arraycopy(sealed, p, part, 0, len);
                            call(t, "PUT", "/mesh/v1/links/" + id + "/" + i + "/" + offset, part, "application/octet-stream", 200);
                            offset += len;
                        }
                    }
                }
            }
            Map<String, Object> done = call(t, "POST", "/mesh/v1/links/" + id + "/done", new byte[0], null, 200);
            if (!(done.get("base") instanceof String)) throw new IOException("The hub did not finish the link.");
            return new Made(id, done.get("base") + "/l/" + id + "#k=" + B64.url(key), System.currentTimeMillis() + expiresInMs);
        } catch (GeneralSecurityException e) {
            throw new IOException("sealing failed", e);
        }
    }

    /** This device's links on the hub `t` points at (as the hub lists them). */
    @SuppressWarnings("unchecked")
    public static List<Map<String, Object>> list(Transport t) throws IOException {
        Http.Response r = t.request("GET", "/mesh/v1/links", new byte[0], null, 30_000, null, null);
        if (r.status != 200) return new ArrayList<>();
        Object j = Json.parse(r.text());
        List<Map<String, Object>> out = new ArrayList<>();
        if (j instanceof List) for (Object o : (List<Object>) j) if (o instanceof Map) out.add((Map<String, Object>) o);
        return out;
    }

    public static void revoke(Transport t, String id) throws IOException {
        if (!id.matches("^[A-Za-z0-9_-]{22}$")) throw new IOException("No such link.");
        Http.Response r = t.request("POST", "/mesh/v1/links/" + id + "/revoke", new byte[0], null, 30_000, null, null);
        if (r.status != 200 && r.status != 404) throw new IOException("The hub did not remove the link.");
    }
}
