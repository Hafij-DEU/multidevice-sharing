package io.github.hafijbge.meshdrop.engine.recv;

import io.github.hafijbge.meshdrop.engine.crypto.Hpke;
import io.github.hafijbge.meshdrop.engine.identity.Identity;
import io.github.hafijbge.meshdrop.engine.net.Http;
import io.github.hafijbge.meshdrop.engine.net.Tls;
import io.github.hafijbge.meshdrop.engine.net.TrustStore;
import io.github.hafijbge.meshdrop.engine.proto.Chunks;
import io.github.hafijbge.meshdrop.engine.proto.Manifest;
import io.github.hafijbge.meshdrop.engine.proto.Offer;
import io.github.hafijbge.meshdrop.engine.proto.Sanitize;
import io.github.hafijbge.meshdrop.engine.util.Json;
import java.io.BufferedInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.SocketTimeoutException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Semaphore;
import java.util.function.BooleanSupplier;
import java.util.function.LongSupplier;
import java.util.regex.Pattern;
import javax.crypto.AEADBadTagException;
import javax.net.ssl.SSLServerSocket;
import javax.net.ssl.SSLSocket;

/**
 * The receiver API over mutual TLS 1.3 (docs/protocol.md "Endpoints (v1)"), ported from
 * packages/core/src/api/handler.ts and server.ts. One request per connection; a bounded number
 * of connections; an idle timeout on every read.
 */
public final class MeshServer {
    public static final int MAX_OFFER_BODY = 64 * 1024 * 1024;
    public static final int MAX_CHUNK_BODY = Chunks.CHUNK_SIZE + 16;
    private static final String PREFIX = "/mesh/v1/";
    private static final Pattern UINT = Pattern.compile("^(0|[1-9][0-9]{0,9})$");

    public static final class Options {
        public int port = 0;
        public int idleTimeoutMs = 30_000;
        public int maxConnections = 64;
        public String alias = "MeshDrop";
        public String deviceType = "mobile";
        public BooleanSupplier accepting = () -> true;
        public LongSupplier meshVersion = () -> 0;
    }

    /** Receiver events: {type, sessionId, from, …} as in docs/protocol.md "Receiver events". */
    public interface Events {
        void emit(Map<String, Object> event);
    }

    private static final class HttpError extends Exception {
        final int status;
        final String code;

        HttpError(int status, String code) {
            super(code);
            this.status = status;
            this.code = code;
        }
    }

    private static final class Live {
        final Manifest manifest;
        final Hpke.Context ctx;

        Live(Manifest manifest, Hpke.Context ctx) {
            this.manifest = manifest;
            this.ctx = ctx;
        }
    }

    private final Identity id;
    private final TrustStore trust;
    private final Inbox inbox;
    private final Events events;
    private final Options opts;
    private final Map<String, Live> live = new ConcurrentHashMap<>();
    private final Map<String, Object> locks = new ConcurrentHashMap<>();
    private final Semaphore slots;
    private volatile SSLServerSocket server;
    private ExecutorService pool;
    private Thread acceptor;

    public MeshServer(Identity id, TrustStore trust, Inbox inbox, Events events, Options opts) {
        this.id = id;
        this.trust = trust;
        this.inbox = inbox;
        this.events = events;
        this.opts = opts;
        this.slots = new Semaphore(opts.maxConnections);
    }

    /** Binds (all interfaces) and starts accepting; returns the bound port. */
    public synchronized int start() throws IOException {
        SSLServerSocket s = (SSLServerSocket) Tls.serverContext(id).getServerSocketFactory().createServerSocket();
        s.setReuseAddress(true);
        s.bind(new java.net.InetSocketAddress(opts.port), 128);
        s.setEnabledProtocols(Tls.PROTOCOLS);
        s.setWantClientAuth(true);
        server = s;
        pool = Executors.newCachedThreadPool(r -> {
            Thread t = new Thread(r, "meshdrop-conn");
            t.setDaemon(true);
            return t;
        });
        acceptor = new Thread(this::acceptLoop, "meshdrop-accept");
        acceptor.setDaemon(true);
        acceptor.start();
        return s.getLocalPort();
    }

    public int port() {
        ServerSocket s = server;
        return s == null ? 0 : s.getLocalPort();
    }

    public synchronized void stop() {
        ServerSocket s = server;
        server = null;
        if (s != null) {
            try {
                s.close();
            } catch (IOException ignored) {
                // closing anyway
            }
        }
        if (pool != null) pool.shutdownNow();
    }

    private void acceptLoop() {
        ServerSocket s;
        while ((s = server) != null) {
            Socket c;
            try {
                c = s.accept();
            } catch (IOException e) {
                if (server == null) return;
                continue;
            }
            if (!slots.tryAcquire()) {
                closeQuietly(c); // over the connection limit
                continue;
            }
            try {
                pool.execute(() -> {
                    try {
                        serve((SSLSocket) c);
                    } finally {
                        slots.release();
                        closeQuietly(c);
                    }
                });
            } catch (RuntimeException e) {
                slots.release();
                closeQuietly(c);
            }
        }
    }

    private static void closeQuietly(Socket c) {
        try {
            c.close();
        } catch (IOException ignored) {
            // nothing to do
        }
    }

    private void serve(SSLSocket sock) {
        try {
            sock.setSoTimeout(opts.idleTimeoutMs);
            sock.startHandshake();
            String peer = Tls.peerId(sock.getSession());
            InputStream in = new BufferedInputStream(sock.getInputStream());
            OutputStream out = sock.getOutputStream();
            Http.Request req;
            try {
                req = Http.readRequest(in);
            } catch (Http.HeadTooLarge e) {
                reply(out, 431, null);
                return;
            } catch (SocketTimeoutException e) {
                return;
            } catch (IOException e) {
                reply(out, 400, err("bad-request"));
                return;
            }
            if (req == null) return;
            int[] status = new int[1];
            byte[] body;
            try {
                body = route(req, peer, status);
            } catch (HttpError e) {
                status[0] = e.status;
                body = err(e.code);
            } catch (Http.BodyTooLarge e) {
                status[0] = 413;
                body = err("too-large");
            } catch (Http.BadRequest e) {
                status[0] = 400;
                body = err("bad-request");
            } catch (SocketTimeoutException e) {
                return;
            } catch (Offer.BadOffer e) {
                status[0] = e.status;
                body = err(e.code);
            } catch (Inbox.ChunkRange e) {
                status[0] = 409;
                body = err("range");
            } catch (Inbox.UnknownSession e) {
                status[0] = 404;
                body = err("unknown-session");
            } catch (Inbox.IntegrityError e) {
                status[0] = 422;
                body = err("integrity");
            } catch (Inbox.Incomplete e) {
                status[0] = 409;
                body = err("incomplete");
            } catch (Sanitize.UnsafePath e) {
                status[0] = 422;
                body = err("bad-offer");
            } catch (IOException e) {
                boolean full = e.getMessage() != null && e.getMessage().contains("No space left");
                Map<String, Object> ev = event("error", null, peer);
                ev.put("code", full ? "ENOSPC" : "EIO");
                emit(ev);
                status[0] = full ? 507 : 500;
                body = err(full ? "no-space" : "internal");
            } catch (Exception e) {
                status[0] = 500;
                body = err("internal");
            }
            reply(out, status[0], body);
        } catch (IOException e) {
            // client gone or handshake failed
        }
    }

    private static void reply(OutputStream out, int status, byte[] json) throws IOException {
        Http.writeResponse(out, status, json, "application/json");
    }

    private static byte[] err(String code) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("error", code);
        return Json.stringify(m).getBytes(StandardCharsets.UTF_8);
    }

    private static byte[] json(Object v) {
        return Json.stringify(v).getBytes(StandardCharsets.UTF_8);
    }

    private void emit(Map<String, Object> e) {
        try {
            events.emit(e);
        } catch (RuntimeException ignored) {
            // a failing listener must not break the request
        }
    }

    private static Map<String, Object> event(String type, String sessionId, String from) {
        Map<String, Object> e = new LinkedHashMap<>();
        e.put("type", type);
        if (sessionId != null) e.put("sessionId", sessionId);
        e.put("from", from);
        return e;
    }

    private Object lock(String sessionId) {
        return locks.computeIfAbsent(sessionId, k -> new Object());
    }

    public Map<String, Object> info() {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("v", 1L);
        m.put("deviceId", id.deviceId());
        m.put("alias", opts.alias);
        m.put("deviceType", opts.deviceType);
        m.put("mv", opts.meshVersion.getAsLong());
        return m;
    }

    // ---- routes ---------------------------------------------------------------------------------

    private byte[] route(Http.Request req, String peer, int[] status) throws Exception {
        String path = req.path;
        int q = path.indexOf('?');
        if (q >= 0) path = path.substring(0, q);
        if (!path.startsWith(PREFIX)) throw new HttpError(404, "not-found");
        String[] seg = path.substring(PREFIX.length()).split("/", -1);
        String m = req.method;
        status[0] = 200;
        if (m.equals("GET") && seg.length == 1 && seg[0].equals("info")) return json(info());
        if (peer == null || !trust.isTrusted(peer)) throw new HttpError(403, "untrusted");
        if (m.equals("POST") && seg.length == 1 && seg[0].equals("offer")) {
            if (!opts.accepting.getAsBoolean()) throw new HttpError(503, "paused");
            return offer(req, peer);
        }
        if (m.equals("PUT") && seg.length == 4 && seg[0].equals("chunk")) {
            status[0] = 204;
            chunk(req, peer, seg);
            return null;
        }
        if (m.equals("POST") && seg.length == 3 && seg[0].equals("complete")) return complete(peer, seg);
        if (m.equals("POST") && seg.length == 2 && seg[0].equals("finish")) return finish(peer, seg);
        if (m.equals("POST") && seg.length == 2 && seg[0].equals("cancel")) {
            status[0] = 204;
            cancel(peer, seg);
            return null;
        }
        throw new HttpError(404, "not-found");
    }

    private static String sessionParam(String s) throws HttpError {
        if (s == null || !Offer.SESSION_ID.matcher(s).matches()) throw new HttpError(404, "unknown-session");
        return s;
    }

    private static long uintParam(String s) throws HttpError {
        if (s == null || !UINT.matcher(s).matches()) throw new HttpError(400, "bad-request");
        long v = Long.parseLong(s);
        if (v > 0xffffffffL) throw new HttpError(400, "bad-request");
        return v;
    }

    private Live getLive(String sid) throws IOException {
        Live l = live.get(sid);
        if (l != null) return l;
        Inbox.Loaded st = inbox.load(sid);
        if (st == null) return null;
        Live fresh = new Live(st.manifest, Chunks.importCtx(st.ctxExport));
        Live racing = live.putIfAbsent(sid, fresh);
        return racing != null ? racing : fresh;
    }

    private Live requireOwned(String sid, String peer) throws IOException, HttpError {
        Live l = getLive(sid);
        if (l == null) throw new HttpError(404, "unknown-session");
        if (!l.manifest.from.equals(peer)) throw new HttpError(403, "forbidden");
        return l;
    }

    @SuppressWarnings("unchecked")
    private byte[] offer(Http.Request req, String peer) throws Exception {
        byte[] body = req.body(MAX_OFFER_BODY);
        Object parsed;
        try {
            parsed = Json.parse(new String(body, StandardCharsets.UTF_8));
        } catch (Json.JsonException e) {
            throw new HttpError(400, "bad-json");
        }
        if (!(parsed instanceof Map)) throw new HttpError(422, "bad-offer");
        Map<String, Object> o = (Map<String, Object>) parsed;
        if (!peer.equals(o.get("from"))) throw new HttpError(403, "forbidden");
        Object sidO = o.get("sessionId");
        if (!(sidO instanceof String) || !Offer.SESSION_ID.matcher((String) sidO).matches()) throw new HttpError(422, "bad-offer");
        String sid = (String) sidO;
        TrustStore.Device device = trust.get(peer);
        if (device == null) throw new HttpError(403, "untrusted");
        synchronized (lock(sid)) {
            Offer.Opened accepted = Offer.open(body, id.keyPair(), id.deviceId(), peer, device.key);
            Inbox.Tombstone tomb = inbox.finished(sid);
            if (tomb != null) {
                if (!tomb.from.equals(peer)) throw new HttpError(403, "forbidden");
                Map<String, Object> r = new LinkedHashMap<>();
                r.put("done", true);
                r.put("files", new ArrayList<Object>(tomb.files));
                return json(r);
            }
            Live existing = getLive(sid);
            if (existing != null) {
                if (!existing.manifest.from.equals(peer)) throw new HttpError(403, "forbidden");
                Inbox.Loaded stored = inbox.load(sid);
                if (stored == null || !Chunks.exportCtx(accepted.ctx).equals(stored.ctxExport)) throw new HttpError(409, "session-conflict");
                return haveReply(sid);
            }
            inbox.begin(sid, accepted.manifest, Chunks.exportCtx(accepted.ctx));
            live.put(sid, new Live(accepted.manifest, accepted.ctx));
            Map<String, Object> ev = event("offer", sid, peer);
            ev.put("manifest", accepted.manifest);
            emit(ev);
            return haveReply(sid);
        }
    }

    private byte[] haveReply(String sid) throws IOException {
        Map<String, Object> have = new LinkedHashMap<>();
        for (Map.Entry<Long, List<Long>> e : inbox.have(sid).entrySet()) have.put(String.valueOf(e.getKey()), new ArrayList<Object>(e.getValue()));
        Map<String, Object> r = new LinkedHashMap<>();
        r.put("have", have);
        return json(r);
    }

    private void chunk(Http.Request req, String peer, String[] seg) throws Exception {
        String sid = sessionParam(seg[1]);
        long fileId = uintParam(seg[2]);
        long index = uintParam(seg[3]);
        Live s = requireOwned(sid, peer);
        Manifest.FileEntry f = s.manifest.file(fileId);
        if (f == null || index >= Chunks.count(f.size)) throw new HttpError(409, "range");
        byte[] ct = req.body(MAX_CHUNK_BODY);
        byte[] pt;
        try {
            pt = Chunks.open(s.ctx, sid, fileId, index, ct);
        } catch (AEADBadTagException e) {
            throw new HttpError(422, "decrypt");
        }
        inbox.writeChunk(sid, fileId, index, pt);
        Map<String, Object> ev = event("progress", sid, peer);
        ev.put("fileId", fileId);
        ev.put("chunks", inbox.haveCount(sid, fileId));
        ev.put("total", Chunks.count(f.size));
        emit(ev);
    }

    private byte[] complete(String peer, String[] seg) throws Exception {
        String sid = sessionParam(seg[1]);
        long fileId = uintParam(seg[2]);
        requireOwned(sid, peer);
        boolean wasDone = inbox.landed(sid, fileId) != null;
        String rel = inbox.finalize(sid, fileId);
        if (!wasDone) {
            Map<String, Object> ev = event("file", sid, peer);
            ev.put("fileId", fileId);
            ev.put("path", inbox.locate(rel));
            emit(ev);
        }
        Map<String, Object> r = new LinkedHashMap<>();
        r.put("path", rel);
        return json(r);
    }

    private byte[] finish(String peer, String[] seg) throws Exception {
        String sid = sessionParam(seg[1]);
        synchronized (lock(sid)) {
            Inbox.Tombstone tomb = inbox.finished(sid);
            if (tomb != null) {
                if (!tomb.from.equals(peer)) throw new HttpError(403, "forbidden");
                if (live.remove(sid) != null || inbox.load(sid) != null) inbox.drop(sid);
                Map<String, Object> r = new LinkedHashMap<>();
                r.put("files", new ArrayList<Object>(tomb.files));
                return json(r);
            }
            Live s = requireOwned(sid, peer);
            List<Long> done = inbox.completed(sid);
            List<String> files = new ArrayList<>();
            for (Manifest.FileEntry f : s.manifest.files) {
                if (!done.contains(f.fileId)) throw new HttpError(409, "incomplete");
                files.add(inbox.finalize(sid, f.fileId));
            }
            inbox.finalizeDirs(sid);
            inbox.markFinished(sid, peer, files);
            Map<String, Object> ev = event("received", sid, peer);
            List<Object> located = new ArrayList<>();
            for (String f : files) located.add(inbox.locate(f));
            ev.put("files", located);
            if (s.manifest.text != null) ev.put("text", s.manifest.text);
            if (s.manifest.clipboard) ev.put("clipboard", true);
            emit(ev);
            live.remove(sid);
            try {
                inbox.drop(sid);
            } catch (IOException ignored) {
                // delivered; leftover partial state is harmless
            }
            Map<String, Object> r = new LinkedHashMap<>();
            r.put("files", new ArrayList<Object>(files));
            return json(r);
        }
    }

    private void cancel(String peer, String[] seg) throws Exception {
        String sid = sessionParam(seg[1]);
        synchronized (lock(sid)) {
            Live s = getLive(sid);
            if (s == null) return; // already gone: idempotent
            if (!s.manifest.from.equals(peer)) throw new HttpError(403, "forbidden");
            live.remove(sid);
            inbox.drop(sid);
            emit(event("cancelled", sid, peer));
        }
    }
}
