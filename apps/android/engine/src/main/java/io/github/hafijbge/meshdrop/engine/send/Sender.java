package io.github.hafijbge.meshdrop.engine.send;

import io.github.hafijbge.meshdrop.engine.crypto.Hpke;
import io.github.hafijbge.meshdrop.engine.identity.Identity;
import io.github.hafijbge.meshdrop.engine.net.Http;
import io.github.hafijbge.meshdrop.engine.net.Tls;
import io.github.hafijbge.meshdrop.engine.net.TrustStore;
import io.github.hafijbge.meshdrop.engine.proto.Chunks;
import io.github.hafijbge.meshdrop.engine.proto.Manifest;
import io.github.hafijbge.meshdrop.engine.proto.Offer;
import io.github.hafijbge.meshdrop.engine.util.Hex;
import io.github.hafijbge.meshdrop.engine.util.Json;
import java.io.IOException;
import java.net.Socket;
import java.nio.ByteBuffer;
import java.nio.channels.SeekableByteChannel;
import java.nio.charset.StandardCharsets;
import java.security.PublicKey;
import java.security.cert.CertificateException;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import java.util.regex.Pattern;
import javax.net.ssl.SSLHandshakeException;
import javax.net.ssl.SSLSocket;

/**
 * The sender (docs/protocol.md "Sender algorithm / resume"), ported from packages/core/src/transfer/send.ts:
 * offer, then the missing chunks (3 in flight), complete per file, finish. Every chunk read is checked
 * against its recorded plaintext hash; retries 0.5/1/2 s on network errors and 5xx; a terminal failure
 * posts a best-effort cancel; a pause keeps the outbox entry and posts nothing.
 */
public final class Sender {
    private static final String PREFIX = "/mesh/v1/";
    public static final int CANCEL_TIMEOUT_MS = 3000;
    private static final Pattern CODE = Pattern.compile("^[a-z0-9-]{1,64}$");
    private static final Set<String> ACTIVE = ConcurrentHashMap.newKeySet();

    // ---- types ----------------------------------------------------------------------------------

    public static final class Target {
        public final String deviceId;
        public final String host;
        public final int port;
        public final PublicKey publicKey;

        public Target(String deviceId, String host, int port, PublicKey publicKey) {
            this.deviceId = deviceId;
            this.host = host;
            this.port = port;
            this.publicKey = publicKey;
        }
    }

    public interface ProgressListener {
        void onProgress(String deviceId, String sessionId, long fileId, long sent, long total);
    }

    /** Pause from outside (user pause, engine stop): the send ends 'cancelled' and stays resumable. */
    public static final class Control {
        final AtomicBoolean paused = new AtomicBoolean();
        final Set<Socket> sockets = ConcurrentHashMap.newKeySet();

        public void pause() {
            paused.set(true);
            for (Socket s : sockets) closeQuietly(s);
        }

        public boolean paused() {
            return paused.get();
        }

        /** The flag itself (Prepared.of stops hashing when it is set). */
        public AtomicBoolean pausedFlag() {
            return paused;
        }
    }

    public static final class Options implements Cloneable {
        public Outbox outbox;
        public ProgressListener progress;
        public Control control = new Control();
        public Source.Resolver resolver = PathSource.RESOLVER;
        public int concurrency = 3;
        public int[] retryDelaysMs = {500, 1000, 2000};
        public int timeoutMs = 30_000;
        public int finalizeTimeoutMs = 10 * 60_000;
        public int connectTimeoutMs = 10_000;

        Options withOutbox(Outbox o) {
            try {
                Options c = (Options) clone();
                c.outbox = o;
                return c;
            } catch (CloneNotSupportedException e) {
                throw new IllegalStateException(e);
            }
        }
    }

    public static final class Aborted extends RuntimeException {
        public Aborted() {
            super("aborted");
        }
    }

    public static final class SourceChanged extends IOException {
        public SourceChanged(String what) {
            super("source changed: " + what);
        }
    }

    /** A name the receiver would rename or refuse (sent names must already be safe). */
    public static final class LocalPathError extends IllegalArgumentException {
        public LocalPathError(String path, String why) {
            super("cannot send " + path + ": " + why);
        }
    }

    static final class HttpStatus extends IOException {
        final int status;
        final String code;

        HttpStatus(int status, String code) {
            super("http-" + status + (code.isEmpty() ? "" : " " + code));
            this.status = status;
            this.code = code;
        }
    }

    static final class PinMismatch extends IOException {
        PinMismatch() {
            super("pin-mismatch");
        }
    }

    static final class Protocol extends IOException {
        Protocol(String m) {
            super(m);
        }
    }

    private Sender() {}

    public static boolean isSessionActive(String sessionId) {
        return ACTIVE.contains(sessionId);
    }

    /** Errors after which a send may resume by itself (Node engine.ts isTransientError). */
    public static boolean isTransientError(String error) {
        if (error == null) return false;
        if (error.matches("^http-4\\d\\d.*")) return false;
        switch (error) {
            case "source-changed":
            case "pin-mismatch":
            case "bad-response":
            case "no-route":
            case "already-running":
            case "target-mismatch":
            case "target-unresolved":
            case "corrupt-entry":
            case "local-path":
                return false;
            default:
                return true;
        }
    }

    static String errorString(Throwable e) {
        if (e instanceof SourceChanged) return "source-changed";
        if (e instanceof PinMismatch) return "pin-mismatch";
        if (e instanceof Protocol) return "bad-response";
        if (e instanceof LocalPathError) return "local-path";
        if (e instanceof HttpStatus) return e.getMessage();
        String m = e.getMessage();
        return m == null || m.isEmpty() ? e.getClass().getSimpleName() : m;
    }

    private static boolean isTransient(Throwable e) {
        if (e instanceof HttpStatus) {
            HttpStatus h = (HttpStatus) e;
            return h.status >= 500 && !(h.status == 507 && (h.code.equals("hub-quota") || h.code.equals("hub-no-space")));
        }
        return !(e instanceof SourceChanged || e instanceof PinMismatch || e instanceof Protocol || e instanceof Aborted);
    }

    private static boolean isTerminal(Throwable e) {
        return e instanceof SourceChanged || (e instanceof HttpStatus && ((HttpStatus) e).status >= 400 && ((HttpStatus) e).status < 500);
    }

    static void closeQuietly(Socket s) {
        try {
            s.close();
        } catch (IOException ignored) {
            // closing anyway
        }
    }

    // ---- one request ----------------------------------------------------------------------------

    private static Http.Response request(Identity me, Target t, String method, String path, byte[] body, int timeoutMs, int connectTimeoutMs, Set<Socket> track)
            throws IOException {
        SSLSocket s;
        try {
            s = Tls.connect(Tls.pinnedClient(me, t.deviceId), t.host, t.port, connectTimeoutMs);
        } catch (SSLHandshakeException e) {
            for (Throwable c = e; c != null; c = c.getCause()) {
                if (c instanceof CertificateException && String.valueOf(c.getMessage()).contains("pin-mismatch")) throw new PinMismatch();
            }
            throw e;
        }
        if (track != null) track.add(s);
        try {
            s.setSoTimeout(timeoutMs);
            Map<String, String> h = new LinkedHashMap<>();
            if (body != null) h.put("Content-Type", path.startsWith(PREFIX + "chunk/") ? "application/octet-stream" : "application/json");
            return Http.request(s, method, path, h, body, 1 << 20);
        } finally {
            if (track != null) track.remove(s);
            closeQuietly(s);
        }
    }

    /** Best effort: one attempt, 3 s, every error ignored. */
    public static boolean postCancel(Identity me, Target t, String sessionId) {
        if (sessionId == null || !Offer.SESSION_ID.matcher(sessionId).matches() || t.host == null) return false;
        try {
            Http.Response r = request(me, t, "POST", PREFIX + "cancel/" + sessionId, null, CANCEL_TIMEOUT_MS, CANCEL_TIMEOUT_MS, null);
            return r.status >= 200 && r.status < 300;
        } catch (IOException | RuntimeException e) {
            return false;
        }
    }

    // ---- sending --------------------------------------------------------------------------------

    private static boolean sameContent(Outbox.Entry e, Prepared p) {
        if (e.manifest.files.size() != p.files.size() || !e.manifest.dirs.equals(p.dirs)) return false;
        if (e.manifest.text == null ? p.text != null : !e.manifest.text.equals(p.text)) return false;
        for (int i = 0; i < p.files.size(); i++) {
            Manifest.FileEntry a = e.manifest.files.get(i), b = p.files.get(i);
            if (a.fileId != b.fileId || !a.path.equals(b.path) || a.size != b.size || !a.sha256.equals(b.sha256)) return false;
        }
        Map<Long, Outbox.SourceRec> recs = new HashMap<>();
        for (Outbox.SourceRec s : e.sources) recs.put(s.fileId, s);
        for (Manifest.FileEntry f : p.files) {
            Outbox.SourceRec r = recs.get(f.fileId);
            long[] st = p.stats.get(f.fileId);
            if (r == null || !r.ref.equals(p.sources.get(f.fileId).ref()) || r.size != st[0] || r.mtime != st[1]) return false;
        }
        return true;
    }

    /** Sends prepared items to one target, resuming a matching outbox entry when the content is unchanged. */
    public static SendResult sendTo(Identity me, Target t, Prepared p, Options o) {
        Outbox.Entry entry = null;
        String sid = "";
        try {
            if (o.outbox != null) {
                Outbox.Entry match = o.outbox.findMatch(t.deviceId, p.itemsKey);
                if (match != null && !ACTIVE.contains(match.sessionId)) {
                    if (sameContent(match, p)) {
                        entry = match;
                    } else {
                        o.outbox.remove(match.sessionId);
                        postCancel(me, t, match.sessionId);
                    }
                }
            }
            if (entry == null) {
                Manifest m = p.manifest(me.deviceId(), t.deviceId, Offer.newSessionId());
                sid = m.sessionId;
                Offer.Created c = Offer.create(me.keyPair(), me.deviceId(), t.publicKey, m, null);
                entry = new Outbox.Entry();
                entry.sessionId = sid;
                entry.createdAt = m.createdAt;
                entry.targetId = t.deviceId;
                entry.targetHost = t.host;
                entry.targetPort = t.port;
                entry.targetKeyPem = TrustStore.pem(t.publicKey);
                entry.itemsKey = p.itemsKey;
                entry.offerJson = c.offer.toJson();
                entry.manifest = m;
                for (Manifest.FileEntry f : p.files) {
                    long[] st = p.stats.get(f.fileId);
                    entry.sources.add(new Outbox.SourceRec(f.fileId, p.sources.get(f.fileId).ref(), st[0], st[1], p.chunkHashes.get(f.fileId)));
                }
                entry.ctxExport = Chunks.exportCtx(c.ctx);
                if (o.outbox != null) o.outbox.save(entry);
            }
        } catch (IOException | RuntimeException e) {
            return new SendResult(t.deviceId, "failed", sid, errorString(e));
        }
        // The prepared sources are already open: resolve their refs to them, others through the resolver.
        Map<String, Source> known = new HashMap<>();
        for (Source src : p.sources.values()) known.put(src.ref(), src);
        Source.Resolver fallback = o.resolver;
        Options withSources = o.withOutbox(o.outbox);
        withSources.resolver = ref -> known.containsKey(ref) ? known.get(ref) : fallback.resolve(ref);
        return runSession(me, t, entry, withSources);
    }

    static SendResult runSession(Identity me, Target t, Outbox.Entry entry, Options o) {
        String sid = entry.sessionId;
        if (!ACTIVE.add(sid)) return new SendResult(t.deviceId, "failed", sid, "already-running");
        AtomicBoolean internal = new AtomicBoolean();
        Set<Socket> sockets = ConcurrentHashMap.newKeySet();
        try {
            if (!t.deviceId.equals(entry.targetId)) throw new Protocol("target-mismatch");
            Hpke.Context ctx = Chunks.importCtx(entry.ctxExport);
            Map<Long, Source> sources = new HashMap<>();
            for (Outbox.SourceRec r : entry.sources) {
                Source s;
                try {
                    s = o.resolver.resolve(r.ref);
                } catch (IOException e) {
                    throw new SourceChanged(r.ref);
                }
                if (s.size() != r.size || s.lastModified() != r.mtime) throw new SourceChanged(r.ref);
                sources.put(r.fileId, s);
            }
            transfer(me, t, entry, ctx, sources, o, internal, sockets);
            if (o.outbox != null) o.outbox.remove(sid);
            return new SendResult(t.deviceId, "done", sid, null);
        } catch (Throwable e) {
            boolean paused = o.control.paused();
            String error = paused ? "cancelled" : errorString(e);
            if (o.outbox != null) {
                entry.lastError = error;
                try {
                    o.outbox.save(entry);
                } catch (IOException ignored) {
                    // the result still says what happened
                }
            }
            if (paused) return new SendResult(t.deviceId, "cancelled", sid, null);
            if (isTerminal(e)) postCancel(me, t, sid);
            return new SendResult(t.deviceId, "failed", sid, error);
        } finally {
            ACTIVE.remove(sid);
        }
    }

    private static final class Task {
        final Manifest.FileEntry file;
        final long index; // -1: complete only

        Task(Manifest.FileEntry file, long index) {
            this.file = file;
            this.index = index;
        }
    }

    /** One request with the retry policy; aborts on pause (external) or on another worker's failure (internal). */
    private static final class Caller {
        final Identity me;
        final Target t;
        final Options o;
        final AtomicBoolean internal;
        final Set<Socket> sockets;

        Caller(Identity me, Target t, Options o, AtomicBoolean internal, Set<Socket> sockets) {
            this.me = me;
            this.t = t;
            this.o = o;
            this.internal = internal;
            this.sockets = sockets;
        }

        Http.Response call(String method, String path, byte[] body, int timeout) throws IOException {
            for (int attempt = 0; ; attempt++) {
                if (o.control.paused() || internal.get()) throw new Aborted();
                try {
                    Http.Response r = request(me, t, method, PREFIX + path, body, timeout, o.connectTimeoutMs, new TrackingSet(sockets, o.control.sockets));
                    if (r.status >= 200 && r.status < 300) return r;
                    throw new HttpStatus(r.status, remoteCode(r));
                } catch (IOException | RuntimeException e) {
                    if (o.control.paused() || internal.get()) throw new Aborted();
                    if (!isTransient(e) || attempt >= o.retryDelaysMs.length) throw e;
                    try {
                        Thread.sleep(o.retryDelaysMs[attempt]);
                    } catch (InterruptedException ie) {
                        Thread.currentThread().interrupt();
                        throw new Aborted();
                    }
                }
            }
        }
    }

    @SuppressWarnings("unchecked")
    private static void transfer(Identity me, Target t, Outbox.Entry entry, Hpke.Context ctx, Map<Long, Source> sources, Options o,
            AtomicBoolean internal, Set<Socket> sockets) throws Throwable {
        String sid = entry.sessionId;
        Control control = o.control;
        Caller caller = new Caller(me, t, o, internal, sockets);

        Http.Response offer = caller.call("POST", "offer", entry.offerJson.getBytes(StandardCharsets.UTF_8), o.timeoutMs);
        Object oj;
        try {
            oj = Json.parse(offer.text());
        } catch (Json.JsonException e) {
            throw new Protocol("bad offer reply");
        }
        if (!(oj instanceof Map)) throw new Protocol("bad offer reply");
        if (Boolean.TRUE.equals(((Map<String, Object>) oj).get("done"))) return; // already delivered (tombstone)
        Map<Long, Set<Long>> have = parseHave(((Map<String, Object>) oj).get("have"));

        List<Task> tasks = new ArrayList<>();
        Map<Long, AtomicInteger> remaining = new ConcurrentHashMap<>();
        Map<Long, long[]> sent = new ConcurrentHashMap<>();
        for (Manifest.FileEntry f : entry.manifest.files) {
            Set<Long> got = have.getOrDefault(f.fileId, Set.of());
            long n = Chunks.count(f.size);
            int missing = 0;
            long bytes = 0;
            for (long i = 0; i < n; i++) {
                long len = Math.min(Chunks.CHUNK_SIZE, f.size - i * Chunks.CHUNK_SIZE);
                if (got.contains(i)) {
                    bytes += len;
                } else {
                    tasks.add(new Task(f, i));
                    missing++;
                }
            }
            remaining.put(f.fileId, new AtomicInteger(missing));
            sent.put(f.fileId, new long[] {bytes});
            if (missing == 0) tasks.add(new Task(f, -1));
        }
        Map<Long, Outbox.SourceRec> recs = new HashMap<>();
        for (Outbox.SourceRec r : entry.sources) recs.put(r.fileId, r);

        AtomicInteger next = new AtomicInteger();
        AtomicReference<Throwable> firstErr = new AtomicReference<>();
        Runnable worker = () -> {
            while (firstErr.get() == null && !control.paused() && !internal.get()) {
                int k = next.getAndIncrement();
                if (k >= tasks.size()) return;
                Task task = tasks.get(k);
                Manifest.FileEntry f = task.file;
                try {
                    if (task.index < 0) {
                        complete(caller, sid, f, o, recs);
                        progress(o, t, sid, f.fileId, f.size, f.size);
                        continue;
                    }
                    byte[] pt = readChunk(sources.get(f.fileId), recs.get(f.fileId), task.index);
                    byte[] ct = Chunks.seal(ctx, sid, f.fileId, task.index, pt);
                    caller.call("PUT", "chunk/" + sid + "/" + f.fileId + "/" + task.index, ct, o.timeoutMs);
                    long s;
                    synchronized (sent.get(f.fileId)) {
                        s = sent.get(f.fileId)[0] += pt.length;
                    }
                    progress(o, t, sid, f.fileId, s, f.size);
                    if (remaining.get(f.fileId).decrementAndGet() == 0) complete(caller, sid, f, o, recs);
                } catch (Throwable e) {
                    if (firstErr.compareAndSet(null, e)) {
                        internal.set(true);
                        for (Socket so : sockets) closeQuietly(so); // stop the other workers' requests
                    }
                    return;
                }
            }
        };
        int n = Math.max(1, Math.min(o.concurrency, Math.max(tasks.size(), 1)));
        List<Thread> threads = new ArrayList<>();
        for (int i = 0; i < n; i++) {
            Thread th = new Thread(worker, "meshdrop-send");
            th.setDaemon(true);
            threads.add(th);
            th.start();
        }
        for (Thread th : threads) th.join();
        if (firstErr.get() != null) throw firstErr.get();
        if (control.paused()) throw new Aborted();
        caller.call("POST", "finish/" + sid, null, o.finalizeTimeoutMs);
    }

    /** Tracks open sockets in both the session's set and the control's set (so pause can close them). */
    private static final class TrackingSet extends java.util.AbstractSet<Socket> {
        final Set<Socket> a;
        final Set<Socket> b;

        TrackingSet(Set<Socket> a, Set<Socket> b) {
            this.a = a;
            this.b = b;
        }

        @Override
        public boolean add(Socket s) {
            b.add(s);
            return a.add(s);
        }

        @Override
        public boolean remove(Object s) {
            b.remove(s);
            return a.remove(s);
        }

        @Override
        public java.util.Iterator<Socket> iterator() {
            return a.iterator();
        }

        @Override
        public int size() {
            return a.size();
        }
    }

    private static void progress(Options o, Target t, String sid, long fileId, long sent, long total) {
        if (o.progress == null) return;
        try {
            o.progress.onProgress(t.deviceId, sid, fileId, sent, total);
        } catch (RuntimeException ignored) {
            // a failing listener must not break the send
        }
    }

    private static void complete(Caller caller, String sid, Manifest.FileEntry f, Options o, Map<Long, Outbox.SourceRec> recs) throws IOException {
        try {
            caller.call("POST", "complete/" + sid + "/" + f.fileId, null, o.finalizeTimeoutMs);
        } catch (HttpStatus e) {
            if (e.status == 422 && e.code.equals("integrity")) {
                Outbox.SourceRec r = recs.get(f.fileId);
                throw new SourceChanged(r != null ? r.ref : "file " + f.fileId);
            }
            throw e;
        }
    }

    private static byte[] readChunk(Source s, Outbox.SourceRec r, long index) throws IOException {
        if (s.size() != r.size || s.lastModified() != r.mtime) throw new SourceChanged(r.ref);
        long start = index * Chunks.CHUNK_SIZE;
        int len = (int) Math.min(Chunks.CHUNK_SIZE, r.size - start);
        ByteBuffer buf = ByteBuffer.allocate(len);
        try (SeekableByteChannel ch = s.open()) {
            ch.position(start);
            while (buf.hasRemaining()) if (ch.read(buf) <= 0) throw new SourceChanged(r.ref);
        }
        byte[] pt = buf.array();
        if (!Hex.of(Prepared.sha().digest(pt)).equals(r.chunks.get((int) index))) throw new SourceChanged(r.ref);
        return pt;
    }

    @SuppressWarnings("unchecked")
    private static Map<Long, Set<Long>> parseHave(Object x) throws Protocol {
        if (!(x instanceof Map)) throw new Protocol("bad have map");
        Map<Long, Set<Long>> out = new HashMap<>();
        for (Map.Entry<String, Object> e : ((Map<String, Object>) x).entrySet()) {
            if (!e.getKey().matches("^(0|[1-9][0-9]*)$") || !(e.getValue() instanceof List)) throw new Protocol("bad have map");
            Set<Long> s = new java.util.HashSet<>();
            for (Object v : (List<Object>) e.getValue()) {
                if (!(v instanceof Long) || (Long) v < 0) throw new Protocol("bad have map");
                s.add((Long) v);
            }
            out.put(Long.parseLong(e.getKey()), s);
        }
        return out;
    }

    private static String remoteCode(Http.Response r) {
        try {
            Object j = Json.parse(r.text());
            Object c = j instanceof Map ? ((Map<?, ?>) j).get("error") : null;
            return c instanceof String && CODE.matcher((String) c).matches() ? (String) c : "";
        } catch (RuntimeException e) {
            return "";
        }
    }
}
