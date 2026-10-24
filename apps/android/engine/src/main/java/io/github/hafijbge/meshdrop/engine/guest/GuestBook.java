package io.github.hafijbge.meshdrop.engine.guest;

import io.github.hafijbge.meshdrop.engine.util.B64;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.ArrayDeque;
import java.util.function.LongSupplier;

/**
 * LAN guest sessions (guest/book.ts): the owner shows a QR code with a one-time token. The first
 * browser that opens it claims the session (it gets a cookie); any other browser with the same link is
 * turned away. One live session per engine; it ends after its TTL, when the owner ends it, or when a
 * new one opens.
 */
public final class GuestBook {
    public static final long GUEST_TTL_MS = 3_600_000;
    private static final int KEEP_OLD = 16;
    private static final SecureRandom RNG = new SecureRandom();

    /** A claim: `cookie` on success, else `error` ("unknown", "used" or "expired"). */
    public static final class Claim {
        public final String cookie;
        public final boolean fresh;
        public final String error;

        Claim(String cookie, boolean fresh, String error) {
            this.cookie = cookie;
            this.fresh = fresh;
            this.error = error;
        }

        public boolean ok() {
            return error == null;
        }
    }

    public static final class Current {
        public final String token;
        public final long expiresAt;
        public final boolean claimed;

        Current(String token, long expiresAt, boolean claimed) {
            this.token = token;
            this.expiresAt = expiresAt;
            this.claimed = claimed;
        }
    }

    private static final class Session {
        final String token;
        final long expiresAt;
        String cookie;

        Session(String token, long expiresAt) {
            this.token = token;
            this.expiresAt = expiresAt;
        }
    }

    private final LongSupplier now;
    private Session live;
    /** Tokens that ended (replaced, ended, timed out), so a stale QR says "expired", not "unknown". */
    private final ArrayDeque<String> old = new ArrayDeque<>();

    public GuestBook() {
        this(System::currentTimeMillis);
    }

    public GuestBook(LongSupplier now) {
        this.now = now;
    }

    private static String random(int n) {
        byte[] b = new byte[n];
        RNG.nextBytes(b);
        return B64.url(b);
    }

    private static boolean same(String a, String b) {
        return a != null && b != null && MessageDigest.isEqual(a.getBytes(StandardCharsets.UTF_8), b.getBytes(StandardCharsets.UTF_8));
    }

    public synchronized Current open(long ttlMs) {
        end();
        live = new Session(random(16), now.getAsLong() + ttlMs);
        return new Current(live.token, live.expiresAt, false);
    }

    public synchronized void end() {
        if (live == null) return;
        old.addLast(live.token);
        if (old.size() > KEEP_OLD) old.removeFirst();
        live = null;
    }

    public synchronized Current current() {
        Session s = session();
        return s == null ? null : new Current(s.token, s.expiresAt, s.cookie != null);
    }

    /** The live session, ended first if its time is up. */
    private Session session() {
        if (live != null && now.getAsLong() > live.expiresAt) end();
        return live;
    }

    private String state(String token) {
        Session s = session();
        if (s != null && same(token, s.token)) return "live";
        for (String t : old) if (same(token, t)) return "expired";
        return "unknown";
    }

    public synchronized Claim claim(String token, String cookie) {
        String st = state(token);
        if (!st.equals("live")) return new Claim(null, false, st);
        if (live.cookie == null) {
            live.cookie = random(32);
            return new Claim(live.cookie, true, null);
        }
        if (same(cookie, live.cookie)) return new Claim(live.cookie, false, null);
        return new Claim(null, false, "used");
    }

    /** "ok", "unknown", "used" or "expired". */
    public synchronized String check(String token, String cookie) {
        String st = state(token);
        if (!st.equals("live")) return st;
        return live.cookie != null && same(cookie, live.cookie) ? "ok" : "used";
    }
}
