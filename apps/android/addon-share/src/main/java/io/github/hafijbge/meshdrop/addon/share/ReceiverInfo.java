package io.github.hafijbge.meshdrop.addon.share;

import android.util.Base64;
import java.nio.charset.StandardCharsets;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * What a ShareMe receiver puts in its QR code: Base64 of a JSON object with its name and id, a
 * "secure" flag, and (again Base64 JSON) the hotspot to join with the address and port it listens on.
 */
final class ReceiverInfo {
    final String name;
    final String id;
    final String ssid;
    final String psk;
    final String ip;
    final int port;
    /** The receiver asks senders for its DH + DES line encryption ("sa"); not enforced on its side. */
    final boolean secure;
    final int version;
    final boolean fiveGhz;

    private ReceiverInfo(String name, String id, String ssid, String psk, String ip, int port, boolean secure, int version, boolean fiveGhz) {
        this.name = name;
        this.id = id;
        this.ssid = ssid;
        this.psk = psk;
        this.ip = ip;
        this.port = port;
        this.secure = secure;
        this.version = version;
        this.fiveGhz = fiveGhz;
    }

    static ReceiverInfo parse(String text) {
        JSONObject o = json(text.trim());
        if (o == null) throw new IllegalArgumentException("not a ShareMe code");
        JSONObject ap = nested(o, "ap");
        if (ap == null) throw new IllegalArgumentException("it has no hotspot details");
        String ssid = ap.optString("ss", "");
        String ip = ap.optString("ip", "");
        int port = ap.optInt("pt", 0);
        if (ssid.isEmpty() || ip.isEmpty() || port <= 0 || port > 65535) throw new IllegalArgumentException("the hotspot details are incomplete");
        JSONObject bt = nested(o, "bt");
        return new ReceiverInfo(o.optString("nm", "ShareMe"), o.optString("id", ""), ssid, ap.optString("pd", ""), ip, port,
                o.optInt("sa", 0) != 0, o.optInt("vs", 0), bt != null && bt.optBoolean("5g", false));
    }

    /** A JSON object given as plain JSON or as Base64 of it; null when it is neither. */
    private static JSONObject json(String s) {
        if (s.startsWith("{")) {
            try {
                return new JSONObject(s);
            } catch (JSONException e) {
                return null;
            }
        }
        try {
            String plain = new String(Base64.decode(s, Base64.DEFAULT), StandardCharsets.UTF_8).trim();
            return plain.startsWith("{") ? new JSONObject(plain) : null;
        } catch (IllegalArgumentException | JSONException e) {
            return null;
        }
    }

    private static JSONObject nested(JSONObject o, String key) {
        JSONObject direct = o.optJSONObject(key);
        if (direct != null) return direct;
        String s = o.optString(key, "");
        return s.isEmpty() ? null : json(s);
    }

    /**
     * The QR content for the log: decoded where possible, with the hotspot password masked. Text that
     * is not ShareMe's format is only counted, since it could be any secret (a Wi-Fi QR, say).
     */
    static String describe(String text) {
        JSONObject o = json(text.trim());
        if (o == null) return "(" + text.length() + " characters, not ShareMe's format)";
        try {
            JSONObject copy = new JSONObject(o.toString());
            copy.remove("pd");
            for (String key : new String[] {"ap", "bt"}) {
                JSONObject inner = nested(o, key);
                if (inner == null) continue;
                if (inner.has("pd")) inner.put("pd", inner.optString("pd", "").isEmpty() ? "" : "***");
                copy.put(key, inner);
            }
            return copy.toString();
        } catch (JSONException e) {
            return "(unreadable)";
        }
    }

    @Override
    public String toString() {
        return name + " (id " + id + ", v" + version + (secure ? ", asks for encryption" : "") + ") on " + ssid
                + (fiveGhz ? " (5 GHz)" : "") + " at " + ip + ":" + port + (psk.isEmpty() ? ", open" : ", with password");
    }
}
