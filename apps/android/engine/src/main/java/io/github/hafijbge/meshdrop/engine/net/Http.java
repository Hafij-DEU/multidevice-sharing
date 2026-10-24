package io.github.hafijbge.meshdrop.engine.net;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.Map;
import javax.net.ssl.SSLSocket;

/** A minimal HTTP/1.1 codec: one request per connection, Content-Length or chunked bodies. */
public final class Http {
    public static final int MAX_HEAD = 16 * 1024;
    public static final int MAX_HEADERS = 100;

    public static final class HeadTooLarge extends IOException {
        HeadTooLarge() {
            super("header block too large");
        }
    }

    public static final class BodyTooLarge extends IOException {
        public BodyTooLarge() {
            super("body too large");
        }
    }

    public static final class BadRequest extends IOException {
        BadRequest(String m) {
            super(m);
        }
    }

    public static final class Request {
        public String method;
        public String path;
        public final Map<String, String> headers = new LinkedHashMap<>();
        InputStream in;

        public String header(String name) {
            return headers.get(name);
        }

        /** Reads the whole body, refusing more than `cap` bytes (also when Content-Length announces more). */
        public byte[] body(int cap) throws IOException {
            String te = header("transfer-encoding");
            if (te != null && te.toLowerCase().contains("chunked")) return readChunked(in, cap);
            String cl = header("content-length");
            if (cl == null) return new byte[0];
            long n;
            try {
                n = Long.parseLong(cl.trim());
            } catch (NumberFormatException e) {
                throw new BadRequest("content-length");
            }
            if (n < 0) throw new BadRequest("content-length");
            if (n > cap) throw new BodyTooLarge();
            return readExactly(in, (int) n);
        }
    }

    public static final class Response {
        public int status;
        public final Map<String, String> headers = new LinkedHashMap<>();
        public byte[] body = new byte[0];

        public String text() {
            return new String(body, StandardCharsets.UTF_8);
        }
    }

    private Http() {}

    /** Reads lines up to the blank line; null at a clean EOF before any byte. */
    private static String[] readHead(InputStream in) throws IOException {
        ByteArrayOutputStream b = new ByteArrayOutputStream();
        int state = 0; // matches \r\n\r\n
        for (;;) {
            int c = in.read();
            if (c < 0) {
                if (b.size() == 0) return null;
                throw new BadRequest("truncated head");
            }
            b.write(c);
            if (b.size() > MAX_HEAD) throw new HeadTooLarge();
            if (c == '\r' && (state == 0 || state == 2)) state++;
            else if (c == '\n' && (state == 1 || state == 3)) state++;
            else state = c == '\r' ? 1 : 0;
            if (state == 4) break;
        }
        String head = new String(b.toByteArray(), StandardCharsets.ISO_8859_1);
        String[] lines = head.substring(0, head.length() - 4).split("\r\n", -1);
        if (lines.length - 1 > MAX_HEADERS) throw new HeadTooLarge();
        return lines;
    }

    private static void parseHeaders(String[] lines, Map<String, String> into) throws BadRequest {
        for (int i = 1; i < lines.length; i++) {
            int colon = lines[i].indexOf(':');
            if (colon <= 0) throw new BadRequest("bad header");
            into.put(lines[i].substring(0, colon).trim().toLowerCase(), lines[i].substring(colon + 1).trim());
        }
    }

    public static Request readRequest(InputStream in) throws IOException {
        String[] lines = readHead(in);
        if (lines == null) return null;
        String[] rl = lines[0].split(" ");
        if (rl.length != 3 || !rl[2].startsWith("HTTP/1.")) throw new BadRequest("bad request line");
        Request r = new Request();
        r.method = rl[0];
        r.path = rl[1];
        parseHeaders(lines, r.headers);
        r.in = in;
        return r;
    }

    static byte[] readExactly(InputStream in, int n) throws IOException {
        byte[] out = new byte[n];
        int off = 0;
        while (off < n) {
            int k = in.read(out, off, n - off);
            if (k < 0) throw new IOException("connection closed mid-body");
            off += k;
        }
        return out;
    }

    private static String readLine(InputStream in) throws IOException {
        ByteArrayOutputStream b = new ByteArrayOutputStream();
        for (;;) {
            int c = in.read();
            if (c < 0) throw new IOException("connection closed");
            if (c == '\n') break;
            if (c != '\r') b.write(c);
            if (b.size() > 1024) throw new BadRequest("line too long");
        }
        return b.toString(StandardCharsets.ISO_8859_1.name());
    }

    static byte[] readChunked(InputStream in, int cap) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        for (;;) {
            String line = readLine(in);
            int semi = line.indexOf(';');
            long n;
            try {
                n = Long.parseLong((semi >= 0 ? line.substring(0, semi) : line).trim(), 16);
            } catch (NumberFormatException e) {
                throw new BadRequest("bad chunk size");
            }
            if (n < 0) throw new BadRequest("bad chunk size");
            if (n == 0) {
                while (!readLine(in).isEmpty()) {
                    // trailers ignored
                }
                return out.toByteArray();
            }
            if (out.size() + n > cap) throw new BodyTooLarge();
            out.write(readExactly(in, (int) n));
            readLine(in);
        }
    }

    private static String reason(int status) {
        switch (status) {
            case 200: return "OK";
            case 204: return "No Content";
            case 400: return "Bad Request";
            case 403: return "Forbidden";
            case 404: return "Not Found";
            case 409: return "Conflict";
            case 413: return "Payload Too Large";
            case 422: return "Unprocessable Entity";
            case 431: return "Request Header Fields Too Large";
            case 503: return "Service Unavailable";
            case 507: return "Insufficient Storage";
            default: return status >= 500 ? "Internal Server Error" : "Status";
        }
    }

    public static void writeResponse(OutputStream out, int status, byte[] body, String contentType) throws IOException {
        StringBuilder h = new StringBuilder("HTTP/1.1 ").append(status).append(' ').append(reason(status)).append("\r\n");
        if (body != null && body.length > 0) {
            if (contentType != null) h.append("Content-Type: ").append(contentType).append("\r\n");
            h.append("Content-Length: ").append(body.length).append("\r\n");
        } else if (status != 204) {
            h.append("Content-Length: 0\r\n");
        }
        h.append("Connection: close\r\n\r\n");
        out.write(h.toString().getBytes(StandardCharsets.ISO_8859_1));
        if (body != null && body.length > 0) out.write(body);
        out.flush();
    }

    public static Response readResponse(InputStream in, int maxBody) throws IOException {
        String[] lines = readHead(in);
        if (lines == null) throw new IOException("connection closed before a response");
        String[] sl = lines[0].split(" ", 3);
        if (sl.length < 2 || !sl[0].startsWith("HTTP/1.")) throw new IOException("bad status line");
        Response r = new Response();
        try {
            r.status = Integer.parseInt(sl[1]);
        } catch (NumberFormatException e) {
            throw new IOException("bad status");
        }
        parseHeaders(lines, r.headers);
        String te = r.headers.get("transfer-encoding");
        String cl = r.headers.get("content-length");
        if (r.status == 204 || r.status == 304) return r;
        if (te != null && te.toLowerCase().contains("chunked")) {
            r.body = readChunked(in, maxBody);
        } else if (cl != null) {
            long n = Long.parseLong(cl.trim());
            if (n > maxBody) throw new BodyTooLarge();
            r.body = readExactly(in, (int) n);
        } else {
            ByteArrayOutputStream b = new ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            for (int k; (k = in.read(buf)) > 0; ) {
                if (b.size() + k > maxBody) throw new BodyTooLarge();
                b.write(buf, 0, k);
            }
            r.body = b.toByteArray();
        }
        return r;
    }

    /** One request on a fresh connection, which is closed afterwards. */
    public static Response request(SSLSocket s, String method, String path, Map<String, String> headers, byte[] body, int maxBody) throws IOException {
        try {
            StringBuilder h = new StringBuilder(method).append(' ').append(path).append(" HTTP/1.1\r\n");
            h.append("Host: ").append(s.getInetAddress().getHostAddress()).append(':').append(s.getPort()).append("\r\n");
            if (headers != null) for (Map.Entry<String, String> e : headers.entrySet()) h.append(e.getKey()).append(": ").append(e.getValue()).append("\r\n");
            if (body != null) h.append("Content-Length: ").append(body.length).append("\r\n");
            else if (!method.equals("GET")) h.append("Content-Length: 0\r\n");
            h.append("Connection: close\r\n\r\n");
            OutputStream out = s.getOutputStream();
            out.write(h.toString().getBytes(StandardCharsets.ISO_8859_1));
            if (body != null) out.write(body);
            out.flush();
            return readResponse(new java.io.BufferedInputStream(s.getInputStream()), maxBody);
        } finally {
            s.close();
        }
    }
}
