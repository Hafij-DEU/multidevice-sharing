package io.github.hafijbge.meshdrop;

import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.LinkAddress;
import android.net.LinkProperties;
import android.net.Network;
import android.net.ConnectivityManager;
import android.net.Uri;
import java.io.File;
import java.io.IOException;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * The Share to Xiaomi add-on: sends to and receives from the share app on Xiaomi phones, built into MeshDrop and off
 * until switched on in Settings. One job at a time (a send or a receive); the page polls
 * {@link #status()} while it runs. Neither the log nor the status ever holds a hotspot password.
 */
final class QrShare {
    private static QrShare instance;

    static synchronized QrShare of(Context ctx, AndroidPlatform platform) {
        if (instance == null) instance = new QrShare(ctx.getApplicationContext(), platform);
        return instance;
    }

    private static final String PREFS = "qrshare";
    private static final int LOG_LINES = 60;

    private final Context ctx;
    private final AndroidPlatform platform;
    private final SharedPreferences prefs;
    private final List<String> log = new ArrayList<>();
    private final List<Map<String, Object>> files = new ArrayList<>();

    private String mode = "idle"; // idle, send, receive
    private String phase = "idle"; // idle, joining, connecting, waiting, transferring, ready, done, error
    private String text = "";
    private String peer = "";
    private String qrSvg;
    private long done;
    private long total;
    private Thread job;
    private QrShareJoin join;
    private QrShareReceiver receiver;
    private long generation;

    private QrShare(Context ctx, AndroidPlatform platform) {
        this.ctx = ctx;
        this.platform = platform;
        this.prefs = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    boolean enabled() {
        return prefs.getBoolean("enabled", false);
    }

    void setEnabled(boolean on) {
        prefs.edit().putBoolean("enabled", on).apply();
        if (!on) stop();
    }

    synchronized Map<String, Object> status() {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("enabled", enabled());
        m.put("mode", mode);
        m.put("phase", phase);
        m.put("text", text);
        m.put("peer", peer);
        m.put("qrSvg", qrSvg);
        m.put("done", done);
        m.put("total", total);
        List<Object> fs = new ArrayList<>();
        for (Map<String, Object> f : files) fs.add(new LinkedHashMap<>(f));
        m.put("files", fs);
        m.put("log", new ArrayList<>(log));
        return m;
    }

    private synchronized void log(String line) {
        log.add(line);
        while (log.size() > LOG_LINES) log.remove(0);
        android.util.Log.i("MeshDrop/QrShare", line);
    }

    private synchronized void set(long gen, String phase, String text) {
        if (gen != generation) return;
        this.phase = phase;
        this.text = text;
    }

    private void requireEnabled() {
        if (!enabled()) throw new IllegalStateException("Turn on Share to Xiaomi in Settings first.");
    }

    /** Starts sending items ({kind, path, name} from the choosers) to the phone whose Xiaomi share code was scanned. */
    synchronized void send(String code, List<Object> items) {
        requireEnabled();
        QrShareCode info;
        try {
            info = QrShareCode.parse(code);
        } catch (IllegalArgumentException e) {
            throw new IllegalStateException("That is not a Xiaomi receive code: " + e.getMessage() + ".");
        }
        List<QrShareItem> batch = new ArrayList<>();
        for (Object o : items) {
            if (!(o instanceof Map)) continue;
            Map<?, ?> it = (Map<?, ?>) o;
            if (!"file".equals(it.get("kind"))) continue;
            String path = (String) it.get("path");
            String name = (String) it.get("name");
            if (path == null) continue;
            QrShareItem s = path.startsWith("content://")
                    ? QrShareItem.of(ctx.getContentResolver(), Uri.parse(path))
                    : QrShareItem.file(new File(path), name);
            if (s == null) throw new IllegalStateException("Cannot read " + (name != null ? name : path) + ".");
            batch.add(s);
        }
        if (batch.isEmpty()) throw new IllegalStateException("Choose files to send (folders and text cannot go to Xiaomi phones).");
        long gen = reset("send", info.name);
        for (QrShareItem s : batch) {
            Map<String, Object> f = new LinkedHashMap<>();
            f.put("name", s.name);
            f.put("size", s.size);
            files.add(f);
            total += s.size;
        }
        phase = "joining";
        text = "Joining " + info.name + "'s hotspot… Android asks you to connect.";
        log("Code: " + info);
        job = new Thread(() -> runSend(gen, info, batch), "qrshare-send");
        job.setDaemon(true);
        job.start();
    }

    private void runSend(long gen, QrShareCode info, List<QrShareItem> batch) {
        QrShareJoin w = new QrShareJoin(ctx);
        synchronized (this) {
            if (gen != generation) return;
            join = w;
        }
        try (QrShareJoin wifi = w) {
            Network net = wifi.join(info.ssid, info.psk);
            set(gen, "connecting", "Connecting to " + info.name + "…");
            InetAddress self = ipv4On(net);
            log("Joined " + info.ssid + (self != null ? " as " + self.getHostAddress() : ""));
            QrShareSender sender = new QrShareSender(info, net, self, this::log, s -> set(gen, accepted(s) ? "transferring" : "waiting", s),
                    (sent, all) -> progress(gen, sent, all));
            try (QrShareFiles server = new QrShareFiles(ctx.getContentResolver(), self, this::log, sender::sent)) {
                sender.send(server, batch);
            }
            synchronized (this) {
                if (gen != generation) return;
                done = total;
                for (Map<String, Object> f : files) f.put("done", true);
            }
            set(gen, "done", "Sent " + batch.size() + (batch.size() == 1 ? " file" : " files") + " to " + info.name + ".");
        } catch (IOException | RuntimeException e) {
            log("Send failed: " + e.getMessage());
            set(gen, "error", "Not sent: " + (e.getMessage() != null ? e.getMessage() : e.toString()));
        } finally {
            synchronized (this) {
                if (join == w) join = null;
            }
        }
    }

    private static boolean accepted(String s) {
        return s.startsWith("Sending");
    }

    private synchronized void progress(long gen, long sent, long all) {
        if (gen != generation) return;
        done = sent;
        if (all > 0) total = all;
        phase = "transferring";
    }

    /** Hosts a hotspot and shows the QR a Xiaomi phone scans to send here. */
    synchronized Map<String, Object> receive() throws IOException {
        requireEnabled();
        long gen = reset("receive", "");
        phase = "joining";
        text = "Starting the hotspot…";
        Map<String, Object> hs;
        try {
            hs = platform.hotspotHost();
        } catch (IOException e) {
            phase = "error";
            text = e.getMessage();
            throw e;
        }
        @SuppressWarnings("unchecked")
        List<Object> ips = (List<Object>) hs.get("ips");
        String ip = ips == null || ips.isEmpty() ? null : String.valueOf(ips.get(0));
        if (ip == null || ip.contains(":")) {
            platform.hotspotStop();
            phase = "error";
            text = "The hotspot started without an address.";
            throw new IOException(text);
        }
        String name = android.os.Build.MODEL + " (MeshDrop)";
        QrShareReceiver r = new QrShareReceiver(name, (String) hs.get("ssid"), (String) hs.get("psk"), ip,
                new File(ctx.getCacheDir(), "qrshare"), this::store, listener(gen));
        receiver = r;
        qrSvg = io.github.hafijbge.meshdrop.engine.guest.GuestPage.qrSvg(r.qrText());
        phase = "ready";
        text = "In ShareMe on the Xiaomi phone, tap Send, pick files, and scan this code.";
        log("Receiving on " + ip + " (hotspot " + hs.get("ssid") + ")");
        return status();
    }

    private QrShareReceiver.Listener listener(long gen) {
        return new QrShareReceiver.Listener() {
            @Override
            public void status(String s) {
                set(gen, "transferring", s);
            }

            @Override
            public void offered(String from, List<String> names, List<Long> sizes) {
                synchronized (QrShare.this) {
                    if (gen != generation) return;
                    peer = from;
                    files.clear();
                    done = 0;
                    total = 0;
                    for (int i = 0; i < names.size(); i++) {
                        Map<String, Object> f = new LinkedHashMap<>();
                        f.put("name", names.get(i));
                        f.put("size", sizes.get(i));
                        files.add(f);
                        total += sizes.get(i);
                    }
                }
            }

            @Override
            public void progress(long d, long t) {
                QrShare.this.progress(gen, d, t);
            }

            @Override
            public void saved(int index, String located) {
                synchronized (QrShare.this) {
                    if (gen != generation || index >= files.size()) return;
                    files.get(index).put("done", true);
                    files.get(index).put("located", located);
                }
            }

            @Override
            public void finished(boolean ok, String why) {
                int n;
                synchronized (QrShare.this) {
                    n = files.size();
                }
                set(gen, ok ? "done" : "error", ok
                        ? "Received " + n + (n == 1 ? " file" : " files") + " into Download/MeshDrop/From Xiaomi. The code still works for another send."
                        : "Not received: " + why);
            }

            @Override
            public void log(String line) {
                QrShare.this.log(line);
            }
        };
    }

    /** Saves under Download/MeshDrop/From Xiaomi/, adding " (2)" and so on when the name is taken. */
    private String store(String name, File data, String mime) throws IOException {
        MediaStoreSink sink = (MediaStoreSink) platform.inboxSink();
        int dot = name.lastIndexOf('.');
        String base = dot > 0 ? name.substring(0, dot) : name;
        String ext = dot > 0 ? name.substring(dot) : "";
        for (int i = 1; i < 1000; i++) {
            String rel = "From Xiaomi/" + (i == 1 ? name : base + " (" + i + ")" + ext);
            if (sink.find(rel) != null) continue;
            String landed = sink.publishAs(rel, data, mime);
            if (landed != null) return sink.locate(landed);
        }
        throw new IOException("too many files named " + name);
    }

    /** Opens a received file in another app. */
    void open(String located) {
        Intent i = platform.viewIntent(located);
        if (i == null) throw new IllegalStateException("That file is gone.");
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            ctx.startActivity(Intent.createChooser(i, null).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        } catch (android.content.ActivityNotFoundException e) {
            throw new IllegalStateException("No app here opens that file.");
        }
    }

    /** Ends the running send or receive and clears the screen. */
    synchronized void stop() {
        reset("idle", "");
        phase = "idle";
    }

    /** Ends what runs and starts a new job; returns its generation. */
    private synchronized long reset(String newMode, String newPeer) {
        generation++;
        Thread t = job;
        job = null;
        if (t != null) t.interrupt();
        QrShareJoin w = join;
        join = null;
        if (w != null) w.close();
        QrShareReceiver r = receiver;
        receiver = null;
        if (r != null) {
            r.close();
            platform.hotspotStop();
        }
        mode = newMode;
        peer = newPeer;
        qrSvg = null;
        text = "";
        done = 0;
        total = 0;
        files.clear();
        log.clear();
        return generation;
    }

    /** This phone's IPv4 address on the joined hotspot (the receiver pulls files from it). */
    private InetAddress ipv4On(Network n) {
        ConnectivityManager cm = ctx.getSystemService(ConnectivityManager.class);
        LinkProperties lp = cm.getLinkProperties(n);
        if (lp == null) return null;
        for (LinkAddress a : lp.getLinkAddresses()) {
            if (a.getAddress() instanceof Inet4Address) return a.getAddress();
        }
        return null;
    }
}
