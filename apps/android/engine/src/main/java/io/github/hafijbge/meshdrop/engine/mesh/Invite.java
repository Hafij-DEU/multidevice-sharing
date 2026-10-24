package io.github.hafijbge.meshdrop.engine.mesh;

import io.github.hafijbge.meshdrop.engine.util.B64;
import java.io.ByteArrayOutputStream;
import java.net.URI;
import java.nio.ByteBuffer;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;

/**
 * QR invites (protocol v1), ported from mesh/invite.ts. The phone only redeems invites, so there is no
 * InviteBook here: the inviter (or the hub) enforces expiry and single use.
 *   meshdrop://join?v=1&s=<secret b64url>&i=<inviter>&r=<mesh>&l=<host:port>...&h=<hub url>...&e=<epoch s>
 */
public final class Invite {
    public static final String JOIN_DOMAIN = "meshdrop-join-v1";
    private static final String PREFIX = "meshdrop://join?";
    private static final Pattern HEX64 = Pattern.compile("^[0-9a-f]{64}$");
    private static final Pattern SECRET = Pattern.compile("^[A-Za-z0-9_-]{22}$");
    private static final Pattern HOST = Pattern.compile("^[A-Za-z0-9.:_-]{1,253}$");
    private static final Pattern ADDR = Pattern.compile("^(?:\\[([0-9A-Fa-f:.]+)\\]|([^:\\[\\]]+)):(\\d{1,5})$");
    private static final Pattern EXPIRY = Pattern.compile("^[0-9]{1,12}$");
    private static final List<String> ORDER = Arrays.asList("v", "s", "i", "r", "l", "h", "e");
    private static final int MAX_LIST = 8;

    public static final class InviteError extends IllegalArgumentException {
        public InviteError(String m) {
            super(m);
        }
    }

    public static final class Addr {
        public final String host;
        public final int port;

        public Addr(String host, int port) {
            this.host = host;
            this.port = port;
        }

        @Override
        public String toString() {
            return host.contains(":") ? "[" + host + "]:" + port : host + ":" + port;
        }
    }

    public final byte[] secret;
    public final String inviter;
    public final String mesh;
    public final List<Addr> lan;
    public final List<String> hubUrls;
    /** Epoch ms; informational only (the joining device never judges expiry). */
    public final long expiresAt;

    public Invite(byte[] secret, String inviter, String mesh, List<Addr> lan, List<String> hubUrls, long expiresAt) {
        this.secret = secret.clone();
        this.inviter = inviter;
        this.mesh = mesh;
        this.lan = Collections.unmodifiableList(new ArrayList<>(lan));
        this.hubUrls = Collections.unmodifiableList(new ArrayList<>(hubUrls));
        this.expiresAt = expiresAt;
    }

    private static InviteError bad(String why) {
        return new InviteError("invalid invite: " + why);
    }

    private static Addr addr(String s) {
        Matcher m = ADDR.matcher(s);
        if (!m.matches()) throw bad("lan address");
        String host = m.group(1) != null ? m.group(1) : m.group(2);
        int port = Integer.parseInt(m.group(3));
        if (!HOST.matcher(host).matches() || port < 1 || port > 65535) throw bad("lan address");
        return new Addr(host, port);
    }

    private static String url(String u) {
        URI p;
        try {
            p = new URI(u);
        } catch (Exception e) {
            throw bad("hub url");
        }
        String host = p.getHost();
        boolean loopback = "127.0.0.1".equals(host) || "localhost".equals(host) || "[::1]".equals(host);
        if (u.length() > 512 || host == null || !("wss".equals(p.getScheme()) || ("ws".equals(p.getScheme()) && loopback))) throw bad("hub url");
        return u;
    }

    public String uri() {
        StringBuilder b = new StringBuilder(PREFIX).append("v=1&s=").append(B64.url(secret)).append("&i=").append(inviter).append("&r=").append(mesh);
        for (Addr a : lan) b.append("&l=").append(encode(a.toString()));
        for (String u : hubUrls) b.append("&h=").append(encode(u));
        return b.append("&e=").append(expiresAt / 1000).toString();
    }

    public static Invite parse(String s) {
        if (s == null || s.length() > 4096 || !s.startsWith(PREFIX)) throw bad("scheme");
        int last = -1;
        Map<String, String> one = new HashMap<>();
        List<Addr> lan = new ArrayList<>();
        List<String> hubs = new ArrayList<>();
        for (String kv : s.substring(PREFIX.length()).split("&", -1)) {
            int eq = kv.indexOf('=');
            if (eq <= 0) throw bad("parameter");
            String k = kv.substring(0, eq);
            String v = decode(kv.substring(eq + 1));
            int idx = ORDER.indexOf(k);
            boolean repeats = k.equals("l") || k.equals("h");
            // Fixed order v, s, i, r, l*, h*, e; only l and h may repeat (consecutively).
            if (idx < 0 || idx < last || (idx == last && !repeats)) throw bad("parameter " + k);
            last = idx;
            if (k.equals("l")) lan.add(addr(v));
            else if (k.equals("h")) hubs.add(url(v));
            else one.put(k, v);
        }
        for (String k : Arrays.asList("v", "s", "i", "r", "e")) if (!one.containsKey(k)) throw bad("missing " + k);
        if (!"1".equals(one.get("v"))) throw bad("version");
        if (!SECRET.matcher(one.get("s")).matches()) throw bad("secret");
        if (!HEX64.matcher(one.get("i")).matches()) throw bad("inviter");
        if (!HEX64.matcher(one.get("r")).matches()) throw bad("mesh");
        if (!EXPIRY.matcher(one.get("e")).matches()) throw bad("expiry");
        if (lan.size() > MAX_LIST || hubs.size() > MAX_LIST) throw bad("too many addresses");
        if (lan.isEmpty() && hubs.isEmpty()) throw bad("no address");
        return new Invite(B64.urlDecode(one.get("s")), one.get("i"), one.get("r"), lan, hubs, Long.parseLong(one.get("e")) * 1000);
    }

    /** base64(HMAC-SHA256(secret, "meshdrop-join-v1\0" + newId + "\0" + inviter)). */
    public static String proof(byte[] secret, String newId, String inviter) {
        try {
            Mac mac = Mac.getInstance("HmacSHA256");
            mac.init(new SecretKeySpec(secret, "HmacSHA256"));
            return B64.std(mac.doFinal((JOIN_DOMAIN + "\0" + newId + "\0" + inviter).getBytes(StandardCharsets.UTF_8)));
        } catch (java.security.GeneralSecurityException e) {
            throw new IllegalStateException(e);
        }
    }

    private static final String UNRESERVED = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.!~*'()";

    /** encodeURIComponent. */
    static String encode(String s) {
        StringBuilder b = new StringBuilder();
        for (byte x : s.getBytes(StandardCharsets.UTF_8)) {
            char c = (char) (x & 0xff);
            if (c < 128 && UNRESERVED.indexOf(c) >= 0) b.append(c);
            else b.append('%').append("0123456789ABCDEF".charAt((x >> 4) & 15)).append("0123456789ABCDEF".charAt(x & 15));
        }
        return b.toString();
    }

    /** decodeURIComponent: '+' stays '+', bad escapes and invalid UTF-8 are errors. */
    static String decode(String s) {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            if (c != '%') {
                byte[] b = String.valueOf(c).getBytes(StandardCharsets.UTF_8);
                out.write(b, 0, b.length);
                continue;
            }
            if (i + 2 >= s.length()) throw bad("encoding");
            int hi = Character.digit(s.charAt(i + 1), 16);
            int lo = Character.digit(s.charAt(i + 2), 16);
            if (hi < 0 || lo < 0) throw bad("encoding");
            out.write(hi * 16 + lo);
            i += 2;
        }
        try {
            return StandardCharsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT).onUnmappableCharacter(CodingErrorAction.REPORT)
                    .decode(ByteBuffer.wrap(out.toByteArray())).toString();
        } catch (CharacterCodingException e) {
            throw bad("encoding");
        }
    }
}
