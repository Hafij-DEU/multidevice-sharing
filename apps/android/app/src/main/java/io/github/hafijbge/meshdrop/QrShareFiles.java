package io.github.hafijbge.meshdrop;

import android.content.ContentResolver;
import android.net.Uri;
import java.io.BufferedInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.SocketTimeoutException;
import java.nio.charset.StandardCharsets;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.function.Consumer;

/**
 * A tiny HTTP server the receiving phone pulls the shared files from (the Xiaomi receiver downloads
 * by GET instead of being pushed to). Serves only what was registered, answers Range requests so a
 * dropped download can resume, and logs every request line because the exact paths are still being
 * learned.
 */
final class QrShareFiles implements AutoCloseable {
    /** One shared file. */
    static final class Item {
        final Uri uri;
        final long size;
        final String mime;

        Item(Uri uri, long size, String mime) {
            this.uri = uri;
            this.size = size;
            this.mime = mime;
        }
    }

    interface Progress {
        void sent(String path, long bytes);
    }

    private static final int MAX_HEAD = 16 * 1024;
    private static final int IDLE_MS = 60_000;

    private final ContentResolver resolver;
    private final Consumer<String> log;
    private final Progress progress;
    private final Map<String, Item> items = new ConcurrentHashMap<>();
    private final ExecutorService pool = Executors.newFixedThreadPool(4);
    private final ServerSocket server;

    QrShareFiles(ContentResolver resolver, InetAddress bind, Consumer<String> log, Progress progress) throws IOException {
        this.resolver = resolver;
        this.log = log;
        this.progress = progress;
        server = new ServerSocket(0, 8, bind);
        Thread t = new Thread(this::acceptLoop, "qrshare-http");
        t.setDaemon(true);
        t.start();
    }

    int port() {
        return server.getLocalPort();
    }

    /** Serves uri at path (which starts with a slash; the query string is ignored when matching). */
    void put(String path, Item item) {
        items.put(path, item);
    }

    private void acceptLoop() {
        while (!server.isClosed()) {
            try {
                Socket s = server.accept();
                pool.execute(() -> handle(s));
            } catch (IOException e) {
                if (!server.isClosed()) log.accept("http: " + e.getMessage());
            }
        }
    }

    private void handle(Socket s) {
        try (Socket sock = s) {
            sock.setSoTimeout(IDLE_MS);
            InputStream in = new BufferedInputStream(sock.getInputStream());
            OutputStream out = sock.getOutputStream();
            for (;;) {
                String head = readHead(in);
                if (head == null) return;
                String[] lines = head.split("\r\n");
                String[] req = lines[0].split(" ");
                log.accept("http " + sock.getInetAddress().getHostAddress() + ": " + lines[0]);
                for (int i = 1; i < lines.length; i++) log.accept("  " + lines[i]);
                if (req.length < 3 || !(req[0].equals("GET") || req[0].equals("HEAD"))) {
                    status(out, "405 Method Not Allowed");
                    return;
                }
                String path = req[1];
                int q = path.indexOf('?');
                Item item = items.get(q < 0 ? path : path.substring(0, q));
                if (item == null) item = items.get(Uri.decode(q < 0 ? path : path.substring(0, q)));
                if (item == null) {
                    status(out, "404 Not Found");
                    continue;
                }
                // the Xiaomi app always asks for "bytes=<have>-" and gets a 206, also from 0 (resume support)
                long from = 0;
                boolean ranged = false;
                String range = header(lines, "range");
                if (range != null && range.startsWith("bytes=") && range.indexOf('-') > 6) {
                    try {
                        from = Long.parseLong(range.substring(6, range.indexOf('-')).trim());
                        ranged = item.size > 0;
                    } catch (RuntimeException ignored) {
                        from = 0;
                    }
                }
                if (from < 0 || (item.size > 0 ? from >= item.size : from > 0)) {
                    out.write(("HTTP/1.1 416 Range Not Satisfiable\r\nContent-Range: bytes */" + item.size + "\r\nContent-Length: 0\r\n\r\n").getBytes(StandardCharsets.US_ASCII));
                    out.flush();
                    continue;
                }
                StringBuilder h = new StringBuilder();
                h.append(ranged ? "HTTP/1.1 206 Partial Content\r\n" : "HTTP/1.1 200 OK\r\n");
                h.append("Content-Type: ").append(item.mime).append("\r\n");
                h.append("Content-Length: ").append(item.size - from).append("\r\n");
                h.append("Accept-Ranges: bytes\r\n");
                h.append("ETag: \"").append(Integer.toHexString(path.hashCode())).append('-').append(Long.toHexString(item.size)).append("\"\r\n");
                if (ranged) h.append("Content-Range: bytes ").append(from).append('-').append(item.size - 1).append('/').append(item.size).append("\r\n");
                h.append("Connection: keep-alive\r\n\r\n");
                out.write(h.toString().getBytes(StandardCharsets.US_ASCII));
                if (req[0].equals("GET")) copy(item, from, out, path);
                out.flush();
                if ("close".equalsIgnoreCase(header(lines, "connection"))) return;
            }
        } catch (SocketTimeoutException ignored) {
            // the receiver went quiet
        } catch (IOException e) {
            log.accept("http: " + e.getMessage());
        }
    }

    private void copy(Item item, long from, OutputStream out, String path) throws IOException {
        try (InputStream src = resolver.openInputStream(item.uri)) {
            if (src == null) throw new IOException("cannot open " + item.uri);
            long skip = from;
            while (skip > 0) {
                long n = src.skip(skip);
                if (n <= 0) throw new IOException("cannot seek in " + item.uri);
                skip -= n;
            }
            byte[] buf = new byte[256 * 1024];
            long left = item.size - from;
            long sent = from;
            while (left > 0) {
                int n = src.read(buf, 0, (int) Math.min(buf.length, left));
                if (n < 0) throw new IOException("file shrank: " + item.uri);
                out.write(buf, 0, n);
                left -= n;
                sent += n;
                progress.sent(path, sent);
            }
        }
    }

    private static void status(OutputStream out, String status) throws IOException {
        out.write(("HTTP/1.1 " + status + "\r\nContent-Length: 0\r\n\r\n").getBytes(StandardCharsets.US_ASCII));
        out.flush();
    }

    private static String header(String[] lines, String name) {
        for (int i = 1; i < lines.length; i++) {
            int c = lines[i].indexOf(':');
            if (c > 0 && lines[i].substring(0, c).trim().equalsIgnoreCase(name)) return lines[i].substring(c + 1).trim();
        }
        return null;
    }

    /** Reads up to the blank line; null at a clean end of stream. */
    private static String readHead(InputStream in) throws IOException {
        ByteArrayOutputStream b = new ByteArrayOutputStream();
        int state = 0;
        for (;;) {
            int c = in.read();
            if (c < 0) {
                if (b.size() == 0) return null;
                throw new IOException("request cut off");
            }
            b.write(c);
            if (b.size() > MAX_HEAD) throw new IOException("request head too large");
            state = (c == '\r' && (state == 0 || state == 2)) ? state + 1 : (c == '\n' && (state == 1 || state == 3)) ? state + 1 : 0;
            if (state == 4) return b.toString(StandardCharsets.ISO_8859_1.name()).trim();
        }
    }

    @Override
    public void close() {
        try {
            server.close();
        } catch (IOException ignored) {
            // already closed
        }
        pool.shutdownNow();
    }
}
