package io.github.hafijbge.meshdrop.engine.guest;

import io.github.hafijbge.meshdrop.engine.net.Http;
import io.github.hafijbge.meshdrop.engine.send.Source;
import io.github.hafijbge.meshdrop.engine.util.Json;
import java.io.BufferedInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.URLDecoder;
import java.net.URLEncoder;
import java.nio.ByteBuffer;
import java.nio.channels.SeekableByteChannel;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Semaphore;
import java.util.function.Supplier;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * The LAN guest server (guest/server.ts): plain HTTP (browsers reject the devices' self-signed
 * certificates), gated by the one-time token in the QR and the cookie its first browser gets. Same
 * routes as the desktop:
 *   GET  /g/<token>                         the page (claims the token)
 *   GET  /g/app.js, /g/app.css              page assets
 *   GET  /g/api/session                     {expiresAt, owner}
 *   GET  /g/api/shared                      [{id, name, size}]   files the owner offers
 *   GET  /g/api/shared/<id>                 one of them (single-range Range supported; ?t=<token> allowed)
 *   POST /g/api/offers                      {files:[{name,size,type?,thumb?}], text?} -> 201 {id, status}
 *   GET  /g/api/offers/<id>                 {status, files:[{name,size,received}]}
 *   PUT  /g/api/offers/<id>/<i>?offset=N    one slice (at most 4 MiB) -> {received}
 * API calls carry the token in X-Guest-Token plus the cookie; a custom header also keeps other sites'
 * pages from calling the API (it needs a CORS preflight, which is never granted).
 */
public final class GuestServer {
    private static final int MAX_OFFER_JSON = 2 * 1024 * 1024;
    private static final Pattern TOKEN_RE = Pattern.compile("^[A-Za-z0-9_-]{22}$");
    private static final Pattern RANGE_RE = Pattern.compile("^bytes=(\\d*)-(\\d*)$");
    private static final String COOKIE = "mdg";
    private static final int MAX_CONNECTIONS = 64;
    /** Connections from one address (a browser opens about six). */
    private static final int MAX_PER_ADDRESS = 16;
    private static final java.util.concurrent.ScheduledExecutorService DEADLINES = Executors.newSingleThreadScheduledExecutor(r -> {
        Thread t = new Thread(r, "meshdrop-guest-deadlines");
        t.setDaemon(true);
        return t;
    });
    private static final int IDLE_MS = 30_000;

    /** A file the owner offers to the guest. */
    public static final class SharedFile {
        public final String id;
        public final String name;
        public final long size;
        public final Source source;

        public SharedFile(String id, String name, long size, Source source) {
            this.id = id;
            this.name = name;
            this.size = size;
            this.source = source;
        }
    }

    public static final class Options {
        public GuestBook book;
        /** The live session's uploads (null: no session). */
        public Supplier<GuestUploads> uploads;
        public Supplier<List<SharedFile>> shared;
        public Supplier<String> alias;
        /** html (with {{TOKEN}}), js, css. */
        public String html;
        public String js;
        public String css;
        /** The link was opened by its (first and only) browser. */
        public Runnable onClaim;
        /** The request head must arrive within this time: a client dripping bytes cannot hold a slot. */
        public int headDeadlineMs = 10_000;
    }

    private static final Map<String, String> HEADERS = new LinkedHashMap<>();

    static {
        HEADERS.put("Cache-Control", "no-store");
        HEADERS.put("X-Content-Type-Options", "nosniff");
        HEADERS.put("Referrer-Policy", "no-referrer");
        HEADERS.put("Content-Security-Policy", "default-src 'self'; img-src 'self' data: blob:; style-src 'self'; script-src 'self'; frame-ancestors 'none'");
    }

    private static final Map<String, String> GONE = new LinkedHashMap<>();

    static {
        GONE.put("used", "This link was already opened in another browser. Ask for a new QR code.");
        GONE.put("expired", "This link has expired. Ask for a new QR code.");
        GONE.put("unknown", "This link is not valid. Ask for a new QR code.");
    }

    /** Header pairs as a map (Map.of needs API 30; minSdk is 29). */
    private static Map<String, String> headers(String... kv) {
        Map<String, String> m = new LinkedHashMap<>();
        for (int i = 0; i + 1 < kv.length; i += 2) m.put(kv[i], kv[i + 1]);
        return m;
    }

    private final Options o;
    private volatile ServerSocket server;
    private ExecutorService pool;
    private final Semaphore slots = new Semaphore(MAX_CONNECTIONS);
    private final java.util.concurrent.ConcurrentHashMap<java.net.InetAddress, Integer> perAddress = new java.util.concurrent.ConcurrentHashMap<>();

    public GuestServer(Options o) {
        this.o = o;
    }

    /** Binds every interface on `port` (0: any free port); returns the bound port. */
    public synchronized int start(int port) throws IOException {
        ServerSocket s = new ServerSocket();
        s.setReuseAddress(true);
        s.bind(new InetSocketAddress(port));
        server = s;
        pool = Executors.newCachedThreadPool(r -> {
            Thread t = new Thread(r, "meshdrop-guest");
            t.setDaemon(true);
            return t;
        });
        Thread t = new Thread(this::acceptLoop, "meshdrop-guest-accept");
        t.setDaemon(true);
        t.start();
        return s.getLocalPort();
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
            java.net.InetAddress from = c.getInetAddress();
            if (perAddress.merge(from, 1, Integer::sum) > MAX_PER_ADDRESS) {
                release(from);
                close(c);
                continue;
            }
            if (!slots.tryAcquire()) {
                release(from);
                close(c);
                continue;
            }
            try {
                pool.execute(() -> {
                    try {
                        serve(c);
                    } catch (Throwable t) {
                        // one bad connection never takes the server down
                    } finally {
                        slots.release();
                        release(from);
                        close(c);
                    }
                });
            } catch (RuntimeException e) {
                slots.release();
                release(from);
                close(c);
            }
        }
    }

    private static void close(Socket c) {
        try {
            c.close();
        } catch (IOException ignored) {
            // nothing to do
        }
    }

    // ---- responses ------------------------------------------------------------------------------

    private static String reason(int status) {
        switch (status) {
            case 200: return "OK";
            case 201: return "Created";
            case 206: return "Partial Content";
            case 400: return "Bad Request";
            case 404: return "Not Found";
            case 409: return "Conflict";
            case 410: return "Gone";
            case 413: return "Payload Too Large";
            case 416: return "Range Not Satisfiable";
            case 429: return "Too Many Requests";
            default: return status >= 500 ? "Internal Server Error" : "Status";
        }
    }

    private static void head(OutputStream out, int status, String type, long length, Map<String, String> extra) throws IOException {
        StringBuilder h = new StringBuilder("HTTP/1.1 ").append(status).append(' ').append(reason(status)).append("\r\n");
        for (Map.Entry<String, String> e : HEADERS.entrySet()) h.append(e.getKey()).append(": ").append(e.getValue()).append("\r\n");
        if (type != null) h.append("Content-Type: ").append(type).append("\r\n");
        h.append("Content-Length: ").append(length).append("\r\n");
        for (Map.Entry<String, String> e : extra.entrySet()) h.append(e.getKey()).append(": ").append(e.getValue()).append("\r\n");
        h.append("Connection: close\r\n\r\n");
        out.write(h.toString().getBytes(StandardCharsets.ISO_8859_1));
    }

    private static void send(OutputStream out, int status, String type, byte[] body, Map<String, String> extra) throws IOException {
        head(out, status, type, body.length, extra);
        out.write(body);
        out.flush();
    }

    private static void json(OutputStream out, int status, Object v) throws IOException {
        send(out, status, "application/json; charset=utf-8", Json.stringify(v).getBytes(StandardCharsets.UTF_8), headers());
    }

    private static Map<String, Object> error(String code) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("error", code);
        return m;
    }

    private static String cookieOf(Http.Request req) {
        String c = req.header("cookie");
        if (c == null) return null;
        for (String part : c.split(";")) {
            String p = part.trim();
            int eq = p.indexOf('=');
            if (eq > 0 && p.substring(0, eq).equals(COOKIE)) return p.substring(eq + 1);
        }
        return null;
    }

    private static Map<String, String> query(String q) {
        Map<String, String> m = new LinkedHashMap<>();
        if (q == null) return m;
        for (String kv : q.split("&")) {
            int eq = kv.indexOf('=');
            String k = eq < 0 ? kv : kv.substring(0, eq);
            String v = eq < 0 ? "" : kv.substring(eq + 1);
            try {
                m.putIfAbsent(URLDecoder.decode(k, "UTF-8"), URLDecoder.decode(v, "UTF-8"));
            } catch (IllegalArgumentException | IOException ignored) {
                // a malformed pair is skipped
            }
        }
        return m;
    }

    // ---- requests -------------------------------------------------------------------------------

    private void release(java.net.InetAddress from) {
        perAddress.computeIfPresent(from, (k, n) -> n <= 1 ? null : n - 1);
    }

    private void serve(Socket sock) throws IOException {
        sock.setSoTimeout(IDLE_MS);
        InputStream in = new BufferedInputStream(sock.getInputStream());
        OutputStream out = sock.getOutputStream();
        Http.Request req;
        java.util.concurrent.ScheduledFuture<?> deadline = DEADLINES.schedule(() -> close(sock), o.headDeadlineMs, java.util.concurrent.TimeUnit.MILLISECONDS);
        try {
            req = Http.readRequest(in);
        } catch (IOException e) {
            return;
        } finally {
            deadline.cancel(false);
        }
        if (req == null) return;
        try {
            handle(req, out);
        } catch (GuestUploads.GuestError e) {
            Map<String, Object> body = error(e.code);
            body.putAll(e.extra);
            json(out, e.status, body);
        } catch (Http.BodyTooLarge e) {
            json(out, 413, error("too-large"));
        } catch (Http.BadRequest e) {
            json(out, 400, error("bad-request"));
        } catch (IOException e) {
            throw e;
        } catch (RuntimeException e) {
            json(out, 500, error("internal"));
        }
    }

    private void handle(Http.Request req, OutputStream out) throws IOException, GuestUploads.GuestError {
        String target = req.path == null ? "/" : req.path;
        int qi = target.indexOf('?');
        String path = qi < 0 ? target : target.substring(0, qi);
        Map<String, String> q = query(qi < 0 ? null : target.substring(qi + 1));
        List<String> seg = new ArrayList<>();
        for (String s : path.split("/", -1)) seg.add(s);
        seg.remove(0); // leading ""
        String method = req.method;
        if (seg.isEmpty() || !seg.get(0).equals("g")) {
            json(out, 404, error("not-found"));
            return;
        }
        if (method.equals("GET") && seg.size() == 2 && seg.get(1).equals("app.js")) {
            send(out, 200, "text/javascript; charset=utf-8", o.js.getBytes(StandardCharsets.UTF_8), headers());
            return;
        }
        if (method.equals("GET") && seg.size() == 2 && seg.get(1).equals("app.css")) {
            send(out, 200, "text/css; charset=utf-8", o.css.getBytes(StandardCharsets.UTF_8), headers());
            return;
        }
        if (method.equals("GET") && seg.size() == 2 && TOKEN_RE.matcher(seg.get(1)).matches()) {
            GuestBook.Claim c = o.book.claim(seg.get(1), cookieOf(req));
            if (!c.ok()) {
                send(out, c.error.equals("unknown") ? 404 : 410, "text/plain; charset=utf-8", GONE.get(c.error).getBytes(StandardCharsets.UTF_8), headers());
                return;
            }
            if (c.fresh && o.onClaim != null) o.onClaim.run();
            send(out, 200, "text/html; charset=utf-8", o.html.replace("{{TOKEN}}", seg.get(1)).getBytes(StandardCharsets.UTF_8),
                    headers("Set-Cookie", COOKIE + "=" + c.cookie + "; Path=/g; HttpOnly; SameSite=Strict"));
            return;
        }
        if (seg.size() < 2 || !seg.get(1).equals("api")) {
            json(out, 404, error("not-found"));
            return;
        }
        // A plain download link cannot send a header: downloads also take the token as ?t= (cookie still required).
        boolean isDownload = method.equals("GET") && seg.size() == 4 && seg.get(2).equals("shared");
        String token = req.header("x-guest-token");
        if (token == null && isDownload) token = q.get("t");
        String st = token != null ? o.book.check(token, cookieOf(req)) : "unknown";
        if (!st.equals("ok")) {
            json(out, st.equals("unknown") ? 404 : 410, error(st.equals("unknown") ? "not-found" : st));
            return;
        }
        GuestUploads uploads = o.uploads.get();
        List<String> api = seg.subList(2, seg.size());
        if (method.equals("GET") && api.size() == 1 && api.get(0).equals("session")) {
            GuestBook.Current cur = o.book.current();
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("expiresAt", cur == null ? 0L : cur.expiresAt);
            m.put("owner", o.alias.get());
            json(out, 200, m);
            return;
        }
        if (method.equals("GET") && api.size() == 1 && api.get(0).equals("shared")) {
            List<Object> list = new ArrayList<>();
            for (SharedFile f : o.shared.get()) {
                Map<String, Object> m = new LinkedHashMap<>();
                m.put("id", f.id);
                m.put("name", f.name);
                m.put("size", f.size);
                list.add(m);
            }
            json(out, 200, list);
            return;
        }
        if (method.equals("GET") && api.size() == 2 && api.get(0).equals("shared")) {
            for (SharedFile f : o.shared.get()) {
                if (f.id.equals(api.get(1))) {
                    serveFile(req, out, f);
                    return;
                }
            }
            json(out, 404, error("not-found"));
            return;
        }
        if (uploads == null) {
            json(out, 410, error("expired"));
            return;
        }
        if (method.equals("POST") && api.size() == 1 && api.get(0).equals("offers")) {
            Object body;
            try {
                body = Json.parse(new String(req.body(MAX_OFFER_JSON), StandardCharsets.UTF_8));
            } catch (Json.JsonException e) {
                throw new GuestUploads.GuestError(400, "bad-offer");
            }
            json(out, 201, uploads.offer(body));
            return;
        }
        if (method.equals("GET") && api.size() == 2 && api.get(0).equals("offers")) {
            json(out, 200, uploads.status(api.get(1)));
            return;
        }
        if (method.equals("PUT") && api.size() == 3 && api.get(0).equals("offers")) {
            String off = q.get("offset");
            if (!api.get(2).matches("^\\d{1,6}$") || off == null || !off.matches("^\\d{1,15}$")) {
                json(out, 400, error("bad-request"));
                return;
            }
            byte[] data = req.body(GuestUploads.MAX_GUEST_SLICE);
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("received", uploads.write(api.get(1), Integer.parseInt(api.get(2)), Long.parseLong(off), data));
            json(out, 200, m);
            return;
        }
        json(out, 404, error("not-found"));
    }

    private static void serveFile(Http.Request req, OutputStream out, SharedFile f) throws IOException {
        long size = f.size;
        long start = 0;
        long end = size - 1;
        int status = 200;
        String range = req.header("range");
        if (range != null) {
            Matcher m = RANGE_RE.matcher(range);
            boolean ok = m.matches();
            String a = ok ? m.group(1) : "";
            String b = ok ? m.group(2) : "";
            if (ok && !a.isEmpty() && a.length() < 19) {
                start = Long.parseLong(a);
                end = b.isEmpty() || b.length() >= 19 ? size - 1 : Math.min(Long.parseLong(b), size - 1);
            } else if (ok && !b.isEmpty() && b.length() < 19) {
                start = Math.max(0, size - Long.parseLong(b));
            } else {
                start = size; // malformed: not satisfiable
            }
            if (start >= size || start > end) {
                head(out, 416, null, 0, headers("Content-Range", "bytes */" + size));
                out.flush();
                return;
            }
            status = 206;
        }
        long len = size == 0 ? 0 : end - start + 1;
        Map<String, String> extra = new LinkedHashMap<>();
        extra.put("Content-Disposition", "attachment; filename*=UTF-8''" + URLEncoder.encode(f.name, "UTF-8").replace("+", "%20"));
        extra.put("Accept-Ranges", "bytes");
        if (status == 206) extra.put("Content-Range", "bytes " + start + "-" + end + "/" + size);
        SeekableByteChannel ch;
        try {
            ch = len == 0 ? null : f.source.open();
        } catch (IOException e) {
            json(out, 404, error("not-found"));
            return;
        }
        try {
            head(out, status, "application/octet-stream", len, extra);
            if (ch != null) {
                ch.position(start);
                ByteBuffer buf = ByteBuffer.allocate(64 * 1024);
                long left = len;
                while (left > 0) {
                    ((java.nio.Buffer) buf).clear(); // Buffer's own methods: ByteBuffer's overrides are not on Android 29
                    if (left < buf.capacity()) ((java.nio.Buffer) buf).limit((int) left);
                    int n = ch.read(buf);
                    if (n < 0) throw new IOException("shared file shrank");
                    out.write(buf.array(), 0, n);
                    left -= n;
                }
            }
            out.flush();
        } finally {
            if (ch != null) ch.close();
        }
    }
}
