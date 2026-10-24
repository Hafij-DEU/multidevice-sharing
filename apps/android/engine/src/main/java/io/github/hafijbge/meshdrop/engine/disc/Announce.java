package io.github.hafijbge.meshdrop.engine.disc;

import io.github.hafijbge.meshdrop.engine.util.Json;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.regex.Pattern;

/** The UDP announce packet (docs/protocol.md "Announce packet"), validated strictly like discovery.ts. */
public final class Announce {
    public static final int MAX_BYTES = 1024;
    public static final int MAX_ALIAS_CHARS = 64;
    private static final Pattern DEVICE_ID = Pattern.compile("^[0-9a-f]{64}$");

    public static final class Peer {
        public final String deviceId;
        public final String alias;
        public final String deviceType;
        public final int port;
        public final String host;

        Peer(String deviceId, String alias, String deviceType, int port, String host) {
            this.deviceId = deviceId;
            this.alias = alias;
            this.deviceType = deviceType;
            this.port = port;
            this.host = host;
        }
    }

    private Announce() {}

    public static boolean isDeviceId(Object x) {
        return x instanceof String && DEVICE_ID.matcher((String) x).matches();
    }

    public static boolean isAlias(Object x) {
        return x instanceof String && ((String) x).length() <= MAX_ALIAS_CHARS;
    }

    public static boolean isDeviceType(Object x) {
        return "desktop".equals(x) || "mobile".equals(x) || "headless".equals(x);
    }

    public static boolean isPort(Object x) {
        return x instanceof Long && (Long) x >= 1 && (Long) x <= 65535;
    }

    /** The peer an announce describes (host = the packet's source address), or null if it is not exactly well-formed. */
    @SuppressWarnings("unchecked")
    public static Peer parse(byte[] buf, int len, String sourceHost) {
        if (len > MAX_BYTES) return null;
        Object j;
        try {
            j = Json.parse(new String(buf, 0, len, StandardCharsets.UTF_8));
        } catch (Json.JsonException e) {
            return null;
        }
        if (!(j instanceof Map)) return null;
        Map<String, Object> o = (Map<String, Object>) j;
        if (!Long.valueOf(1).equals(o.get("v"))) return null;
        if (!isDeviceId(o.get("deviceId")) || !isAlias(o.get("alias")) || !isDeviceType(o.get("deviceType")) || !isPort(o.get("port"))) return null;
        return new Peer((String) o.get("deviceId"), (String) o.get("alias"), (String) o.get("deviceType"), ((Long) o.get("port")).intValue(), sourceHost);
    }

    public static byte[] encode(String deviceId, String alias, String deviceType, int port) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("v", 1L);
        m.put("deviceId", deviceId);
        m.put("alias", alias);
        m.put("deviceType", deviceType);
        m.put("port", (long) port);
        return Json.stringify(m).getBytes(StandardCharsets.UTF_8);
    }
}
