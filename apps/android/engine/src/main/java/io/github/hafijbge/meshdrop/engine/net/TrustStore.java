package io.github.hafijbge.meshdrop.engine.net;

import io.github.hafijbge.meshdrop.engine.crypto.P256;
import io.github.hafijbge.meshdrop.engine.proto.Manifest;
import io.github.hafijbge.meshdrop.engine.util.Atomic;
import io.github.hafijbge.meshdrop.engine.util.Json;
import io.github.hafijbge.meshdrop.engine.util.Io;
import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.security.PublicKey;
import java.util.ArrayList;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/** Manually paired devices, <home>/trust.json: {"devices":[{deviceId, alias, publicKeyPem, addedAt}]} (Node's format). */
public final class TrustStore implements TrustSource {
    public static final class Device {
        public final String deviceId;
        public final String alias;
        public final String publicKeyPem;
        public final long addedAt;
        public final PublicKey key;

        public Device(String deviceId, String alias, String publicKeyPem, long addedAt) {
            this.deviceId = deviceId;
            this.alias = alias;
            this.publicKeyPem = publicKeyPem;
            this.addedAt = addedAt;
            this.key = parsePem(publicKeyPem);
        }
    }

    private final File file;
    private final Map<String, Device> devices = new LinkedHashMap<>();
    private long loadedStamp = Long.MIN_VALUE;

    public TrustStore(File file) throws IOException {
        this.file = file;
        reload();
    }

    public static String pem(PublicKey k) {
        String b64 = Base64.getMimeEncoder(64, "\n".getBytes(StandardCharsets.US_ASCII)).encodeToString(P256.spki(k));
        return "-----BEGIN PUBLIC KEY-----\n" + b64 + "\n-----END PUBLIC KEY-----\n";
    }

    /** SPKI PEM of an EC P-256 key; anything else (private key, certificate, other curve) is refused. */
    public static PublicKey parsePem(String pem) {
        String t = pem.replace("\r\n", "\n").trim();
        if (!t.startsWith("-----BEGIN PUBLIC KEY-----") || !t.endsWith("-----END PUBLIC KEY-----")) throw new IllegalArgumentException("expected an SPKI PEM");
        String body = t.substring("-----BEGIN PUBLIC KEY-----".length(), t.length() - "-----END PUBLIC KEY-----".length()).replaceAll("\\s", "");
        return P256.publicFromSpki(Base64.getDecoder().decode(body));
    }

    private long stamp() {
        return file.exists() ? file.lastModified() ^ (file.length() << 20) : -1;
    }

    /** Re-reads the file if it changed on disk (another process paired a device). */
    @SuppressWarnings("unchecked")
    private synchronized void reload() throws IOException {
        long st = stamp();
        if (st == loadedStamp) return;
        devices.clear();
        loadedStamp = st;
        if (st == -1) return;
        Object o = Json.parse(Io.readString(file.toPath()));
        if (!(o instanceof Map) || !(((Map<String, Object>) o).get("devices") instanceof List)) throw new IOException("corrupt trust store " + file);
        for (Object d : (List<Object>) ((Map<String, Object>) o).get("devices")) {
            Map<String, Object> m = (Map<String, Object>) d;
            Object added = m.get("addedAt");
            devices.put((String) m.get("deviceId"),
                    new Device((String) m.get("deviceId"), (String) m.get("alias"), (String) m.get("publicKeyPem"), added instanceof Number ? ((Number) added).longValue() : 0));
        }
    }

    private void fresh() {
        try {
            reload();
        } catch (IOException | RuntimeException e) {
            // keep the last good view
        }
    }

    @Override
    public synchronized Device get(String deviceId) {
        fresh();
        return devices.get(deviceId);
    }

    @Override
    public synchronized boolean isTrusted(String deviceId) {
        return get(deviceId) != null;
    }

    public synchronized List<Device> list() {
        fresh();
        return new ArrayList<>(devices.values());
    }

    public synchronized Device add(String deviceId, String alias, String publicKeyPem) throws IOException {
        if (!Manifest.DEVICE_ID.matcher(deviceId).matches()) throw new IllegalArgumentException("invalid device id");
        fresh();
        Device d = new Device(deviceId, alias, pem(parsePem(publicKeyPem)), System.currentTimeMillis());
        devices.put(deviceId, d);
        persist();
        return d;
    }

    public synchronized void remove(String deviceId) throws IOException {
        fresh();
        if (devices.remove(deviceId) != null) persist();
    }

    private void persist() throws IOException {
        List<Object> out = new ArrayList<>();
        for (Device d : devices.values()) {
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("deviceId", d.deviceId);
            m.put("alias", d.alias);
            m.put("publicKeyPem", d.publicKeyPem);
            m.put("addedAt", d.addedAt);
            out.add(m);
        }
        Map<String, Object> root = new LinkedHashMap<>();
        root.put("devices", out);
        Atomic.write(file, (Json.stringify(root) + "\n").getBytes(StandardCharsets.UTF_8));
        loadedStamp = stamp();
    }
}
