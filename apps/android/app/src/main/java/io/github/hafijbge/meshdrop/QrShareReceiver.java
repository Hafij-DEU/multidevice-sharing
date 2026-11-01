package io.github.hafijbge.meshdrop;

import android.net.Uri;
import android.os.Build;
import android.util.Base64;
import java.io.BufferedInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.SocketTimeoutException;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * Speaks the Xiaomi share app's transfer protocol as the receiving side, in its plaintext mode. This phone hosts
 * the hotspot whose details go in the QR code; the sender joins it, connects to the control port,
 * offers a "send_files2" list, and this side pulls every file over HTTP from the sender and reports
 * back with status messages. One sender at a time; others are turned away as the Xiaomi app does.
 */
final class QrShareReceiver implements AutoCloseable {
    interface Listener {
        /** A short line for the screen ("Receiving from Redmi…"). */
        void status(String text);

        /** A batch was offered: names and sizes, in order. */
        void offered(String peer, List<String> names, List<Long> sizes);

        /** Bytes received so far of the whole batch. */
        void progress(long done, long total);

        /** One file is saved; located is where it landed (for opening it). */
        void saved(int index, String located);

        /** The batch ended: ok, or why not. */
        void finished(boolean ok, String why);

        void log(String line);
    }

    /** Where received files go: a unique path under the inbox, given a name and its temp file. */
    interface Store {
        String save(String name, File data, String mime) throws IOException;
    }

    private static final String NS = "http://www.xiaomi.com/midrop";
    private static final int VERSION_CODE = 34805;
    static final int PORT = 8181;
    private static final int MAX_LINE = 5 * 1024 * 1024;
    private static final long PING_MS = 20_000;
    private static final int HTTP_MS = 30_000;
    private static final int TRIES = 4;

    private final String name;
    private final String ssid;
    private final String psk;
    private final String ip;
    private final File tmpDir;
    private final Store store;
    private final Listener listener;
    private final String id = Integer.toString(new SecureRandom().nextInt(900_000_000) + 100_000_000);
    private final ServerSocket server;
    private volatile Peer current;
    private volatile boolean closed;

    QrShareReceiver(String name, String ssid, String psk, String ip, File tmpDir, Store store, Listener listener) throws IOException {
        this.name = name;
        this.ssid = ssid;
        this.psk = psk;
        this.ip = ip;
        this.tmpDir = tmpDir;
        this.store = store;
        this.listener = listener;
        ServerSocket s = new ServerSocket();
        s.setReuseAddress(true);
        try {
            s.bind(new InetSocketAddress(InetAddress.getByName(ip), PORT), 4);
        } catch (IOException taken) {
            s.close();
            s = new ServerSocket(0, 4, InetAddress.getByName(ip));
        }
        server = s;
        Thread t = new Thread(this::acceptLoop, "qrshare-recv");
        t.setDaemon(true);
        t.start();
    }

    /**
     * The QR text the Xiaomi app's scanner reads: Base64 of {nm,id,ic,ap,sa,rq,vs}, where ap is Base64 of the
     * hotspot {ss,pd,ip,pt}. Holds the hotspot password, so it goes only into the QR picture.
     */
    String qrText() {
        try {
            JSONObject ap = new JSONObject().put("ss", ssid).put("pd", psk).put("ip", ip).put("pt", server.getLocalPort());
            JSONObject o = new JSONObject()
                    .put("nm", name)
                    .put("id", id)
                    .put("ic", 1)
                    .put("ap", b64(plain(ap.toString())))
                    .put("sa", 0)
                    .put("rq", 0)
                    .put("vs", VERSION_CODE);
            return b64(plain(o.toString()));
        } catch (JSONException e) {
            throw new IllegalStateException(e);
        }
    }

    private static String b64(String s) {
        return Base64.encodeToString(s.getBytes(StandardCharsets.UTF_8), Base64.NO_WRAP);
    }

    private void acceptLoop() {
        while (!closed) {
            try {
                Socket s = server.accept();
                Peer busy = current;
                if (busy != null && busy.alive() && !busy.addr.equals(s.getInetAddress())) {
                    listener.log("Turned away " + s.getInetAddress().getHostAddress() + " (already receiving)");
                    Peer away = new Peer(s);
                    try {
                        away.message("ReceptionStatus", "RejectKickOff");
                    } catch (IOException ignored) {
                        // it left already
                    }
                    away.close();
                    continue;
                }
                if (busy != null) busy.close();
                Peer p = new Peer(s);
                current = p;
                Thread t = new Thread(p::run, "qrshare-peer");
                t.setDaemon(true);
                t.start();
            } catch (IOException e) {
                if (!closed) listener.log("accept: " + e.getMessage());
            }
        }
    }

    @Override
    public void close() {
        closed = true;
        try {
            server.close();
        } catch (IOException ignored) {
            // already closed
        }
        Peer p = current;
        if (p != null) p.close();
    }

    /** One sender's control connection. */
    private final class Peer {
        final Socket sock;
        final InetAddress addr;
        final OutputStream out;
        final Object writing = new Object();
        volatile long lastWrite = System.currentTimeMillis();
        volatile boolean over;
        volatile boolean cancelled;
        volatile HttpURLConnection http;
        volatile Thread downloader;
        int pings;
        String from = "Xiaomi phone";

        Peer(Socket s) throws IOException {
            sock = s;
            addr = s.getInetAddress();
            s.setTcpNoDelay(true);
            s.setKeepAlive(true);
            out = s.getOutputStream();
        }

        boolean alive() {
            return !over && !sock.isClosed();
        }

        void run() {
            listener.log("Connected: " + addr.getHostAddress());
            String why = "";
            try {
                sock.setSoTimeout(5000);
                InputStream in = new BufferedInputStream(sock.getInputStream());
                ByteArrayOutputStream line = new ByteArrayOutputStream();
                for (;;) {
                    int c;
                    try {
                        c = in.read();
                    } catch (SocketTimeoutException idle) {
                        if (System.currentTimeMillis() - lastWrite >= PING_MS) ping();
                        continue;
                    }
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
            listener.log("Disconnected: " + addr.getHostAddress() + (why.isEmpty() ? "" : " (" + why + ")"));
            Thread d = downloader;
            if (d != null && d.isAlive()) {
                cancelled = true;
                HttpURLConnection h = http;
                if (h != null) h.disconnect();
            }
            close();
        }

        void onLine(String text) throws IOException {
            JSONObject o;
            try {
                o = new JSONObject(text);
            } catch (JSONException e) {
                listener.log("< (not JSON, " + text.length() + " characters)");
                return;
            }
            JSONObject ping = o.optJSONObject("ping");
            if (ping != null) {
                if ("ping".equals(ping.optString("type"))) {
                    Object pid = ping.opt("id");
                    write(json("ping", "type", "pong", "id", pid != null ? pid : "0"));
                }
                return;
            }
            JSONObject msg = o.optJSONObject("message");
            if (msg != null) {
                listener.log("< message " + clip(msg.optString("body")));
                return;
            }
            JSONObject iq = o.optJSONObject("iq");
            if (iq == null) {
                listener.log("< " + clip(text));
                return;
            }
            String action = iq.optString("action");
            String param = Uri.decode(iq.optString("param", ""));
            String model = iq.optString("from", "");
            if (!model.isEmpty()) from = model;
            listener.log("< iq " + action + (param.isEmpty() ? "" : " " + clip(param)));
            switch (action) {
                case "send_files2":
                case "send_files":
                    offer(param);
                    break;
                case "cancel_sending":
                    cancelled = true;
                    HttpURLConnection h = http;
                    if (h != null) h.disconnect();
                    break;
                case "send_apk_list":
                case "downloaded_per_file":
                    break; // the Xiaomi app offering its own APK, or echoing progress: nothing to do
                default:
                    iq("unknown_action_ack", action);
                    break;
            }
        }

        void offer(String param) throws IOException {
            if (downloader != null && downloader.isAlive()) {
                listener.log("A second list while one is downloading; ignored");
                return;
            }
            List<String[]> files = new ArrayList<>(); // name, uri, type
            List<String> names = new ArrayList<>();
            List<Long> sizes = new ArrayList<>();
            try {
                JSONArray list = new JSONObject(param).getJSONArray("list");
                for (int i = 0; i < list.length(); i++) {
                    JSONObject f = list.getJSONObject(i);
                    String n = safeName(f.optString("name", "file"));
                    files.add(new String[] {n, f.optString("uri", ""), f.optString("type", "File")});
                    names.add(n);
                    sizes.add(Math.max(0, f.optLong("sze", 0)));
                }
            } catch (JSONException e) {
                message("ReceptionStatus", "Reject");
                listener.finished(false, "could not read the file list");
                return;
            }
            if (files.isEmpty()) return;
            message("ReceptionStatus", "Accept");
            message("DownloadStatus", "Downloading");
            listener.offered(from, names, sizes);
            listener.status("Receiving from " + from + "…");
            cancelled = false;
            Thread t = new Thread(() -> download(files, sizes), "qrshare-pull");
            t.setDaemon(true);
            downloader = t;
            t.start();
        }

        void download(List<String[]> files, List<Long> sizes) {
            long total = 0;
            for (long s : sizes) total += s;
            long[] doneBefore = {0};
            try {
                if (!tmpDir.isDirectory() && !tmpDir.mkdirs()) throw new IOException("cannot prepare " + tmpDir);
                for (int i = 0; i < files.size(); i++) {
                    String[] f = files.get(i);
                    File tmp = new File(tmpDir, "part-" + id + "-" + i);
                    long size = sizes.get(i);
                    pull(url(f[1]), tmp, size, doneBefore[0], total);
                    if (cancelled) throw new IOException("cancelled");
                    String located = store.save(f[0], tmp, QrShareItem.mimeOf(f[0]));
                    doneBefore[0] += size;
                    listener.progress(doneBefore[0], total);
                    listener.saved(i, located);
                    message("DownloadStatus", "DownloadPerFileFinished");
                    String fileId = f[1].substring(f[1].lastIndexOf('/') + 1);
                    try {
                        iq("downloaded_per_file", plain(new JSONObject().put("file_id", fileId).toString()));
                    } catch (JSONException e) {
                        throw new IOException(e);
                    }
                }
                message("DownloadStatus", "DownloadFinished");
                over = true;
                listener.finished(true, "");
            } catch (IOException e) {
                boolean stop = cancelled;
                try {
                    message("DownloadStatus", stop ? "DownloadCancelled" : "DownloadFailed");
                } catch (IOException ignored) {
                    // the sender is gone
                }
                over = true;
                listener.finished(false, stop ? "cancelled" : (e.getMessage() != null ? e.getMessage() : e.toString()));
            } finally {
                File[] parts = tmpDir.listFiles((d, n) -> n.startsWith("part-" + id + "-"));
                if (parts != null) for (File p : parts) p.delete();
            }
        }

        /** The file's URL on the sender: its uri is ":port/id" (or a full path or URL). */
        URL url(String uri) throws IOException {
            String host = addr.getHostAddress();
            if (uri.startsWith("http://") || uri.startsWith("https://")) return new URL(uri);
            if (uri.startsWith(":")) return new URL("http://" + host + uri);
            if (uri.startsWith("/")) return new URL("http://" + host + uri);
            throw new IOException("unknown file address " + clip(uri));
        }

        /** Downloads into tmp, resuming with a Range request after a dropped connection. */
        void pull(URL url, File tmp, long size, long before, long total) throws IOException {
            IOException last = null;
            for (int attempt = 1; attempt <= TRIES && !cancelled; attempt++) {
                long have = tmp.length();
                if (size > 0 && have >= size) return;
                HttpURLConnection h = (HttpURLConnection) url.openConnection();
                http = h;
                try {
                    h.setConnectTimeout(HTTP_MS);
                    h.setReadTimeout(HTTP_MS);
                    h.setRequestProperty("Range", "bytes=" + have + "-");
                    h.setRequestProperty("Accept-Encoding", "identity");
                    int code = h.getResponseCode();
                    boolean append = code == 206;
                    if (code != 200 && code != 206) throw new IOException("the sender answered HTTP " + code);
                    if (!append) have = 0;
                    try (InputStream in = h.getInputStream(); OutputStream o = new FileOutputStream(tmp, append)) {
                        byte[] buf = new byte[256 * 1024];
                        long lastTick = 0;
                        for (int n; (n = in.read(buf)) > 0; ) {
                            if (cancelled) throw new IOException("cancelled");
                            o.write(buf, 0, n);
                            have += n;
                            long now = System.currentTimeMillis();
                            if (now - lastTick >= 300) {
                                lastTick = now;
                                listener.progress(before + have, total);
                            }
                        }
                    }
                    if (size <= 0 || have >= size) return;
                    last = new IOException("the download stopped early");
                } catch (IOException e) {
                    last = e;
                    listener.log("http try " + attempt + ": " + e.getMessage());
                } finally {
                    h.disconnect();
                    http = null;
                }
            }
            if (cancelled) throw new IOException("cancelled");
            throw last != null ? last : new IOException("download failed");
        }

        void message(String kind, String value) throws IOException {
            try {
                String body = new JSONObject().put("status", kind).put("value", value).toString();
                write(new JSONObject().put("message", new JSONObject().put("id", "0").put("body", body)));
            } catch (JSONException e) {
                throw new IOException(e);
            }
        }

        void iq(String action, String param) throws IOException {
            try {
                JSONObject iq = new JSONObject()
                        .put("type", "set")
                        .put("id", id)
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

        void ping() throws IOException {
            write(json("ping", "type", "ping", "id", String.valueOf(++pings)));
        }

        void write(JSONObject o) throws IOException {
            byte[] b = (plain(o.toString()) + "\n").getBytes(StandardCharsets.UTF_8);
            synchronized (writing) {
                out.write(b);
                out.flush();
                lastWrite = System.currentTimeMillis();
            }
        }

        void close() {
            try {
                sock.close();
            } catch (IOException ignored) {
                // already closed
            }
        }
    }

    private static JSONObject json(String key, String k1, Object v1, String k2, Object v2) throws IOException {
        try {
            return new JSONObject().put(key, new JSONObject().put(k1, v1).put(k2, v2));
        } catch (JSONException e) {
            throw new IOException(e);
        }
    }

    /** A sender's file name, without folders or names the file system would refuse. */
    private static String safeName(String n) {
        String s = n.replace('/', '_').replace('\\', '_').replace('\0', '_').trim();
        if (s.isEmpty() || s.equals(".") || s.equals("..")) s = "file";
        return s.length() > 200 ? s.substring(s.length() - 200) : s;
    }

    /** Android's JSON writer escapes every slash; the Xiaomi app's own lines do not, so undo it. */
    private static String plain(String json) {
        return json.replace("\\/", "/");
    }

    private static String clip(String s) {
        return s.length() <= 400 ? s : s.substring(0, 400) + "…";
    }

    @Override
    public String toString() {
        return String.format(Locale.ROOT, "Share-to-Xiaomi receiver %s on %s:%d", name, ip, server.getLocalPort());
    }
}
