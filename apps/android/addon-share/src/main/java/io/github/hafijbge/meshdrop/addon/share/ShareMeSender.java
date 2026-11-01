package io.github.hafijbge.meshdrop.addon.share;

import android.net.Uri;
import android.os.Build;
import java.io.BufferedInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;
import java.util.function.Consumer;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * Speaks ShareMe's transfer protocol as the sending side, in its plaintext mode: newline-separated
 * JSON over TCP to the receiver's port, one "send_files2" list of what to fetch, and then the
 * receiver pulls each file over HTTP from {@link FileServer} and reports back with status messages.
 * The optional key exchange (which would switch the lines to DES) is never started.
 */
final class ShareMeSender {
    private static final String NS = "http://www.xiaomi.com/midrop";
    /** The ShareMe version the protocol was learned from; the receiver picks peer features by it. */
    private static final int VERSION_CODE = 34805;
    private static final int MAX_LINE = 5 * 1024 * 1024;
    /** Larger batches use a multi-part list that has not been worked out. */
    private static final int MAX_FILES = 500;
    private static final int CONNECT_TRIES = 5;
    private static final int CONNECT_MS = 10_000;
    private static final long PING_MS = 20_000;
    /** How long the receiver may take to accept (it can ask its user first). */
    private static final long ACCEPT_MS = 2 * 60_000;
    /** How long a running transfer may go without a byte served or a word from the receiver. */
    private static final long STALL_MS = 3 * 60_000;

    /** A status message from the receiver ("ReceptionStatus"/"Accept"), an iq ("iq"/action), or "closed". */
    private static final class Event {
        final String kind;
        final String value;

        Event(String kind, String value) {
            this.kind = kind;
            this.value = value;
        }
    }

    private final ReceiverInfo info;
    private final InetAddress self;
    private final Consumer<String> log;
    private final Consumer<String> status;
    private final BlockingQueue<Event> events = new LinkedBlockingQueue<>();
    private final Map<String, Long> served = new ConcurrentHashMap<>();
    private final String deviceId = String.format(Locale.ROOT, "%08x", new SecureRandom().nextInt());
    private final Object writing = new Object();
    private volatile long lastWrite;
    private volatile long lastActivity;
    private volatile long lastStatus;
    private volatile long total;
    private int pings;
    private Socket sock;
    private OutputStream out;

    ShareMeSender(ReceiverInfo info, InetAddress self, Consumer<String> log, Consumer<String> status) {
        this.info = info;
        this.self = self;
        this.log = log;
        this.status = status;
    }

    /** Called by the HTTP server while it streams: bytes is how far into the file at path it got. */
    void sent(String path, long bytes) {
        served.put(path, bytes);
        long now = System.currentTimeMillis();
        lastActivity = now;
        if (now - lastStatus < 500) return;
        lastStatus = now;
        long sum = 0;
        for (long b : served.values()) sum += b;
        status.accept("Sending… " + mb(sum) + " of " + mb(total));
    }

    /** Offers the batch to the receiver and returns once it reports every file downloaded. */
    void send(FileServer files, List<Shared> batch) throws IOException {
        if (batch.isEmpty()) throw new IOException("nothing to send");
        if (batch.size() > MAX_FILES) throw new IOException("ShareMe takes at most " + MAX_FILES + " files at once");
        JSONArray list = new JSONArray();
        int tag = new SecureRandom().nextInt() & 0x7fffffff;
        long sum = 0;
        try {
            for (int i = 0; i < batch.size(); i++) {
                Shared s = batch.get(i);
                // the receiver splits the uri at its first slash, so the id must not contain one
                String fileId = String.format(Locale.ROOT, "%x-%x-%x", i + 1, s.size, tag);
                files.put("/" + fileId, new FileServer.Item(s.uri, s.size, "application/octet-stream"));
                sum += s.size;
                list.put(new JSONObject()
                        .put("name", s.name)
                        .put("type", typeOf(s))
                        .put("sze", s.size)
                        .put("uri", ":" + files.port() + "/" + fileId)
                        .put("preview", "")
                        .put("file_path", "/storage/emulated/0/Download/" + s.name));
            }
        } catch (JSONException e) {
            throw new IOException(e);
        }
        total = sum;
        connect();
        Thread reader = new Thread(this::readLoop, "addon-share-shareme");
        reader.setDaemon(true);
        reader.start();
        boolean accepted = false;
        boolean over = false;
        int done = 0;
        try {
            iq("send_files2", list(list));
            status.accept("Waiting for " + info.name + " to accept…");
            long started = System.currentTimeMillis();
            lastActivity = started;
            for (;;) {
                Event e;
                try {
                    e = events.poll(1, TimeUnit.SECONDS);
                } catch (InterruptedException ie) {
                    Thread.currentThread().interrupt();
                    throw new IOException("stopped");
                }
                long now = System.currentTimeMillis();
                if (now - lastWrite >= PING_MS) ping();
                if (e == null) {
                    if (!accepted && now - started > ACCEPT_MS) throw new IOException(info.name + " did not accept in time");
                    if (accepted && now - lastActivity > STALL_MS) throw new IOException("the transfer stalled");
                    continue;
                }
                lastActivity = now;
                if (e.kind.equals("closed")) {
                    over = true;
                    // some versions may hang up instead of sending DownloadFinished
                    if (done >= batch.size()) return;
                    throw new IOException(info.name + " closed the connection" + (e.value.isEmpty() ? "" : " (" + e.value + ")"));
                }
                switch (e.kind + "/" + e.value) {
                    case "ReceptionStatus/Accept":
                    case "DownloadStatus/Downloading":
                        if (!accepted) status.accept("Sending to " + info.name + "…");
                        accepted = true;
                        break;
                    case "ReceptionStatus/Reject":
                        over = true;
                        throw new IOException(info.name + " declined");
                    case "ReceptionStatus/RejectKickOff":
                        over = true;
                        throw new IOException(info.name + " is already receiving from another phone");
                    case "ReceptionStatus/InsufficientStorage":
                        over = true;
                        throw new IOException(info.name + " does not have enough free space");
                    case "DownloadStatus/DownloadPerFileFinished":
                        done++;
                        log.accept("ShareMe: " + done + " of " + batch.size() + " received");
                        break;
                    case "DownloadStatus/DownloadFinished":
                        over = true;
                        log.accept("ShareMe: all received");
                        return;
                    case "DownloadStatus/DownloadFailed":
                        over = true;
                        throw new IOException(info.name + " could not download the files");
                    case "DownloadStatus/DownloadCancelled":
                        over = true;
                        throw new IOException("cancelled on " + info.name);
                    default:
                        break;
                }
            }
        } finally {
            if (accepted && !over) {
                try {
                    iq("cancel_sending", null);
                } catch (IOException ignored) {
                    // the connection is already gone
                }
            }
            close();
        }
    }

    private void connect() throws IOException {
        IOException last = null;
        for (int i = 1; i <= CONNECT_TRIES; i++) {
            Socket s = new Socket();
            try {
                s.setTcpNoDelay(true);
                s.setKeepAlive(true);
                // the receiver fetches the files from this connection's source address, which must be
                // the address the HTTP server listens on
                if (self != null) s.bind(new InetSocketAddress(self, 0));
                s.connect(new InetSocketAddress(info.ip, info.port), CONNECT_MS);
                sock = s;
                out = s.getOutputStream();
                log.accept("Connected to " + info.ip + ":" + info.port + " from " + s.getLocalAddress().getHostAddress());
                return;
            } catch (IOException e) {
                last = e;
                try {
                    s.close();
                } catch (IOException ignored) {
                    // never connected
                }
                log.accept("Connect try " + i + ": " + e.getMessage());
                if (i < CONNECT_TRIES) {
                    try {
                        Thread.sleep(1000);
                    } catch (InterruptedException ie) {
                        Thread.currentThread().interrupt();
                        throw new IOException("stopped");
                    }
                }
            }
        }
        throw new IOException("could not reach " + info.name + " at " + info.ip + ":" + info.port + (last != null ? " (" + last.getMessage() + ")" : ""));
    }

    private void readLoop() {
        String why = "";
        try {
            InputStream in = new BufferedInputStream(sock.getInputStream());
            ByteArrayOutputStream line = new ByteArrayOutputStream();
            for (;;) {
                int c = in.read();
                if (c < 0) break;
                if (c != '\n') {
                    if (line.size() >= MAX_LINE) throw new IOException("a line longer than 5 MiB");
                    line.write(c);
                    continue;
                }
                String text = line.toString(StandardCharsets.UTF_8.name()).trim();
                line.reset();
                if (!text.isEmpty()) onLine(text);
            }
        } catch (IOException e) {
            why = e.getMessage() != null ? e.getMessage() : e.toString();
        }
        events.add(new Event("closed", why));
    }

    private void onLine(String text) {
        try {
            JSONObject o = new JSONObject(text);
            JSONObject ping = o.optJSONObject("ping");
            if (ping != null) {
                if ("ping".equals(ping.optString("type"))) {
                    Object id = ping.opt("id");
                    write(new JSONObject().put("ping", new JSONObject().put("type", "pong").put("id", id != null ? id : "0")));
                }
                return;
            }
            log.accept("< " + clip(text));
            JSONObject msg = o.optJSONObject("message");
            if (msg != null) {
                JSONObject body = new JSONObject(msg.optString("body", "{}"));
                events.add(new Event(body.optString("status"), body.optString("value")));
                return;
            }
            JSONObject iq = o.optJSONObject("iq");
            if (iq != null) {
                String action = iq.optString("action");
                String param = Uri.decode(iq.optString("param", ""));
                log.accept("  iq " + action + (param.isEmpty() ? "" : " " + clip(param)));
                events.add(new Event("iq", action));
            }
        } catch (JSONException | IOException e) {
            log.accept("< " + clip(text) + "  (not understood: " + e.getMessage() + ")");
        }
    }

    private void iq(String action, String param) throws IOException {
        log.accept("> iq " + action + (param == null ? "" : " " + clip(param)));
        try {
            JSONObject iq = new JSONObject()
                    .put("type", "set")
                    .put("id", deviceId)
                    .put("xmlns", NS)
                    .put("action", action)
                    .put("param", param == null ? "" : Uri.encode(param))
                    .put("from", Build.MODEL)
                    .put("profile", -1)
                    .put("versionCode", VERSION_CODE);
            write(new JSONObject().put("iq", iq));
        } catch (JSONException e) {
            throw new IOException(e);
        }
    }

    private void ping() throws IOException {
        try {
            write(new JSONObject().put("ping", new JSONObject().put("type", "ping").put("id", String.valueOf(++pings))));
        } catch (JSONException e) {
            throw new IOException(e);
        }
    }

    private void write(JSONObject o) throws IOException {
        byte[] b = (plain(o.toString()) + "\n").getBytes(StandardCharsets.UTF_8);
        synchronized (writing) {
            out.write(b);
            out.flush();
            lastWrite = System.currentTimeMillis();
        }
    }

    private static String list(JSONArray list) throws IOException {
        try {
            return plain(new JSONObject().put("list", list).toString());
        } catch (JSONException e) {
            throw new IOException(e);
        }
    }

    /** Android's JSON writer escapes every slash; ShareMe's own lines do not, so undo it. */
    private static String plain(String json) {
        return json.replace("\\/", "/");
    }

    /** ShareMe's file kinds; APKs go as plain files since its ApkFile kind expects app details. */
    private static String typeOf(Shared s) {
        if (s.mime.startsWith("image/")) return "PhotoFile";
        if (s.mime.startsWith("audio/")) return "MusicFile";
        if (s.mime.startsWith("video/")) return "VideoFile";
        return "File";
    }

    private static String clip(String s) {
        return s.length() <= 600 ? s : s.substring(0, 600) + "…";
    }

    private static String mb(long bytes) {
        return String.format(Locale.ROOT, "%.1f MB", bytes / 1e6);
    }

    private void close() {
        Socket s = sock;
        if (s == null) return;
        try {
            s.close();
        } catch (IOException ignored) {
            // already closed
        }
    }
}
