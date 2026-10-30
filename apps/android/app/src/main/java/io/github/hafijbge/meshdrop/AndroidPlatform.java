package io.github.hafijbge.meshdrop;

import android.app.Activity;
import android.content.ClipData;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.provider.DocumentsContract;
import android.provider.OpenableColumns;
import android.content.ClipboardManager;
import android.content.Context;
import android.net.wifi.WifiManager;
import io.github.hafijbge.meshdrop.engine.EngineConfig;
import io.github.hafijbge.meshdrop.engine.app.AppController;
import io.github.hafijbge.meshdrop.engine.app.Platform;
import io.github.hafijbge.meshdrop.engine.identity.KeyVault;
import io.github.hafijbge.meshdrop.engine.recv.InboxSink;
import io.github.hafijbge.meshdrop.engine.send.PathSource;
import io.github.hafijbge.meshdrop.engine.send.SendItem;
import io.github.hafijbge.meshdrop.engine.send.Source;
import java.io.IOException;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/** Android's side of the AppController: clipboard, notifications, storage, pickers and share intents. */
public class AndroidPlatform implements Platform {
    protected final Context ctx;
    protected AppController controller;
    /** Items shared into MeshDrop and not yet taken by the UI (takeSharedItems). */
    private final List<Map<String, Object>> shared = new ArrayList<>();

    AndroidPlatform(Context ctx) {
        this.ctx = ctx;
    }

    void attach(AppController c) {
        this.controller = c;
    }

    private MediaStoreSink sink;

    KeyVault keyVault() {
        return new KeystoreVault();
    }

    InboxSink inboxSink() {
        if (sink == null) sink = new MediaStoreSink(ctx);
        return sink;
    }

    EngineConfig.MulticastHooks multicastHooks() {
        WifiManager wifi = (WifiManager) ctx.getSystemService(Context.WIFI_SERVICE);
        WifiManager.MulticastLock lock = wifi.createMulticastLock("meshdrop");
        lock.setReferenceCounted(false);
        return new EngineConfig.MulticastHooks() {
            @Override
            public void acquire() {
                lock.acquire();
            }

            @Override
            public void release() {
                if (lock.isHeld()) lock.release();
            }
        };
    }

    /**
     * While a transfer, live stream or remote input is active: a partial wake lock (the CPU keeps running
     * with the screen off) and Wi-Fi locks (the radio does not doze), released after the engine reports
     * idle. Low latency holds while MeshDrop is on screen (webcam, mic, touchpad); high performance covers
     * the screen-off case before API 34, where it stopped working.
     */
    @SuppressWarnings("deprecation") // WIFI_MODE_FULL_HIGH_PERF: the only mode that holds with the screen off before API 34
    EngineConfig.ActivityListener transferLocks() {
        android.os.PowerManager pm = ctx.getSystemService(android.os.PowerManager.class);
        android.os.PowerManager.WakeLock wake = pm.newWakeLock(android.os.PowerManager.PARTIAL_WAKE_LOCK, "meshdrop:transfer");
        wake.setReferenceCounted(false);
        WifiManager wifi = (WifiManager) ctx.getSystemService(Context.WIFI_SERVICE);
        WifiManager.WifiLock wl = wifi.createWifiLock(WifiManager.WIFI_MODE_FULL_HIGH_PERF, "meshdrop:transfer");
        wl.setReferenceCounted(false);
        WifiManager.WifiLock fast = wifi.createWifiLock(WifiManager.WIFI_MODE_FULL_LOW_LATENCY, "meshdrop:live");
        fast.setReferenceCounted(false);
        return busy -> {
            if (busy) {
                wake.acquire(6 * 60 * 60 * 1000L); // a safety cap; idle releases it much sooner
                wl.acquire();
                fast.acquire();
            } else {
                if (wake.isHeld()) wake.release();
                if (wl.isHeld()) wl.release();
                if (fast.isHeld()) fast.release();
            }
        };
    }

    Source.Resolver resolver() {
        return UriSource.resolver(ctx);
    }

    private static final String RECEIVED = "received";
    private int nextNote = 100;

    @Override
    public void notify(String title, String body, String openRef) {
        android.app.NotificationManager nm = ctx.getSystemService(android.app.NotificationManager.class);
        if (nm.getNotificationChannel(RECEIVED) == null) {
            nm.createNotificationChannel(new android.app.NotificationChannel(RECEIVED, "Received", android.app.NotificationManager.IMPORTANCE_DEFAULT));
        }
        Intent open = openRef != null ? viewIntent(openRef) : null;
        if (open == null) open = new Intent(ctx, MainActivity.class);
        android.app.PendingIntent pi = android.app.PendingIntent.getActivity(ctx, nextNote, open.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
                android.app.PendingIntent.FLAG_IMMUTABLE);
        android.app.Notification n = new android.app.Notification.Builder(ctx, RECEIVED)
                .setSmallIcon(R.drawable.ic_notify)
                .setContentTitle(title)
                .setContentText(body)
                .setContentIntent(pi)
                .setAutoCancel(true)
                .build();
        try {
            nm.notify(nextNote++, n);
        } catch (SecurityException ignored) {
            // notifications not allowed
        }
    }

    private static final android.net.Uri[] MEDIA = {
        android.provider.MediaStore.Images.Media.getContentUri(android.provider.MediaStore.VOLUME_EXTERNAL),
        android.provider.MediaStore.Video.Media.getContentUri(android.provider.MediaStore.VOLUME_EXTERNAL),
    };

    @Override
    public boolean supportsBackup() {
        return true;
    }

    @Override
    public boolean mediaPermission() {
        if (android.os.Build.VERSION.SDK_INT >= 33) {
            return ctx.checkSelfPermission(android.Manifest.permission.READ_MEDIA_IMAGES) == android.content.pm.PackageManager.PERMISSION_GRANTED;
        }
        return ctx.checkSelfPermission(android.Manifest.permission.READ_EXTERNAL_STORAGE) == android.content.pm.PackageManager.PERMISSION_GRANTED;
    }

    @Override
    public List<Media> cameraMediaAfter(long afterId, int limit) {
        List<Media> out = new ArrayList<>();
        if (!mediaPermission()) return out;
        for (android.net.Uri base : MEDIA) {
            String[] cols = {android.provider.MediaStore.MediaColumns._ID};
            String sel = android.provider.MediaStore.MediaColumns._ID + " > ? AND " + android.provider.MediaStore.MediaColumns.RELATIVE_PATH + " LIKE 'DCIM/%' AND "
                    + android.provider.MediaStore.MediaColumns.IS_PENDING + " = 0";
            try (Cursor c = ctx.getContentResolver().query(base, cols, sel, new String[] {String.valueOf(afterId)},
                    android.provider.MediaStore.MediaColumns._ID + " ASC")) {
                if (c == null) continue;
                while (c.moveToNext() && out.size() < limit * 2) {
                    long id = c.getLong(0);
                    out.add(new Media(id, android.content.ContentUris.withAppendedId(base, id).toString()));
                }
            } catch (RuntimeException e) {
                // a volume that cannot be read now: next time
            }
        }
        out.sort((a, b) -> Long.compare(a.id, b.id));
        return out.size() > limit ? new ArrayList<>(out.subList(0, limit)) : out;
    }

    @Override
    public long cameraMediaMaxId() {
        long max = 0;
        if (!mediaPermission()) return 0;
        for (android.net.Uri base : MEDIA) {
            try (Cursor c = ctx.getContentResolver().query(base, new String[] {android.provider.MediaStore.MediaColumns._ID},
                    android.provider.MediaStore.MediaColumns.RELATIVE_PATH + " LIKE 'DCIM/%'", null, android.provider.MediaStore.MediaColumns._ID + " DESC")) {
                if (c != null && c.moveToFirst()) max = Math.max(max, c.getLong(0));
            } catch (RuntimeException ignored) {
                // none readable
            }
        }
        return max;
    }

    @Override
    public String thumbnail(String located) {
        Uri u = sink == null ? null : sink.uriForLocated(located);
        if (u == null) return null;
        try {
            android.graphics.Bitmap b = ctx.getContentResolver().loadThumbnail(u, new android.util.Size(192, 192), null);
            java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
            b.compress(android.graphics.Bitmap.CompressFormat.JPEG, 80, out);
            return "data:image/jpeg;base64," + android.util.Base64.encodeToString(out.toByteArray(), android.util.Base64.NO_WRAP);
        } catch (IOException | RuntimeException e) {
            return null; // not an image or video, or gone
        }
    }

    /** ACTION_VIEW for a received file (its MediaStore item), or null. */
    Intent viewIntent(String located) {
        Uri u = sink == null ? null : sink.uriForLocated(located);
        if (u == null) return null;
        String type = ctx.getContentResolver().getType(u);
        return new Intent(Intent.ACTION_VIEW).setDataAndType(u, type).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
    }

    @Override
    public void writeClipboard(String text) {
        ClipboardManager cm = (ClipboardManager) ctx.getSystemService(Context.CLIPBOARD_SERVICE);
        cm.setPrimaryClip(ClipData.newPlainText("MeshDrop", text));
    }

    /** Copied images or files: the clip's content URIs (readable only while MeshDrop is in front, like text). */
    @Override
    public List<String> clipboardUris() {
        List<String> out = new ArrayList<>();
        try {
            ClipboardManager cm = (ClipboardManager) ctx.getSystemService(Context.CLIPBOARD_SERVICE);
            ClipData c = cm.getPrimaryClip();
            if (c == null) return out;
            for (int i = 0; i < c.getItemCount(); i++) {
                Uri u = c.getItemAt(i).getUri();
                if (u != null && "content".equals(u.getScheme())) out.add(u.toString());
            }
        } catch (RuntimeException e) {
            // no access now (in the background): nothing copied as far as we can tell
        }
        return out;
    }

    /** Received copied files: their MediaStore items go on the clipboard, so paste works in any app. */
    @Override
    public void writeClipboardFiles(List<String> refs) {
        ClipData clip = null;
        for (String r : refs) {
            Uri u = sink == null ? null : sink.uriForLocated(r);
            if (u == null) continue;
            if (clip == null) clip = ClipData.newUri(ctx.getContentResolver(), "MeshDrop", u);
            else clip.addItem(new ClipData.Item(u));
        }
        if (clip == null) return;
        ClipboardManager cm = (ClipboardManager) ctx.getSystemService(Context.CLIPBOARD_SERVICE);
        cm.setPrimaryClip(clip);
    }

    @Override
    public String readClipboard() {
        ClipboardManager cm = (ClipboardManager) ctx.getSystemService(Context.CLIPBOARD_SERVICE);
        ClipData c = cm.getPrimaryClip();
        if (c == null || c.getItemCount() == 0) return "";
        CharSequence t = c.getItemAt(0).coerceToText(ctx);
        return t == null ? "" : t.toString();
    }

    @Override
    public void openInbox() {
        // The system Downloads app (the MeshDrop folder is inside it).
        Intent i = new Intent(android.app.DownloadManager.ACTION_VIEW_DOWNLOADS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            ctx.startActivity(i);
        } catch (RuntimeException ignored) {
            // no downloads app
        }
    }

    @Override
    public void reveal(String ref) {
        Intent i = viewIntent(ref);
        if (i == null) throw new IllegalArgumentException("That file is no longer in Download/MeshDrop.");
        ctx.startActivity(Intent.createChooser(i, null).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
    }

    @Override
    public SendItem item(String kind, String pathOrUri) throws IOException {
        if (pathOrUri.startsWith("content://")) {
            Uri u = Uri.parse(pathOrUri);
            return kind.equals("dir") ? SendItem.dir(UriSource.tree(ctx, u)) : SendItem.file(new UriSource(ctx, u));
        }
        Path p = java.nio.file.Paths.get(pathOrUri);
        return kind.equals("dir") ? SendItem.dir(PathSource.tree(p)) : SendItem.file(PathSource.file(p));
    }

    private static String prop(String k) {
        try {
            return (String) Class.forName("android.os.SystemProperties").getMethod("get", String.class).invoke(null, k);
        } catch (ReflectiveOperationException | RuntimeException e) {
            return "";
        }
    }

    String rom() {
        Map<String, String> props = new LinkedHashMap<>();
        for (String k : new String[] {"ro.miui.ui.version.name", "ro.mi.os.version.name", "ro.tranos.type", "ro.os.hios.version"}) props.put(k, prop(k));
        return io.github.hafijbge.meshdrop.engine.app.KeepAlive.rom(props, android.os.Build.MANUFACTURER);
    }

    boolean batteryUnrestricted() {
        android.os.PowerManager pm = ctx.getSystemService(android.os.PowerManager.class);
        return pm != null && pm.isIgnoringBatteryOptimizations(ctx.getPackageName());
    }

    @Override
    public void decorate(Map<String, Object> state) {
        state.put("platform", "android");
        android.app.NotificationManager nm = ctx.getSystemService(android.app.NotificationManager.class);
        state.put("keepAlive", io.github.hafijbge.meshdrop.engine.app.KeepAlive.state(rom(), batteryUnrestricted(), nm != null && nm.areNotificationsEnabled()));
        synchronized (shared) {
            state.put("sharedPending", (long) shared.size());
        }
        String link = joinLink;
        if (link != null) state.put("joinLink", link);
    }

    @Override
    public void joinHandled() {
        joinLink = null;
    }

    void addShared(List<Map<String, Object>> items) {
        synchronized (shared) {
            shared.addAll(items);
        }
        if (controller != null) controller.refresh();
    }

    List<Map<String, Object>> takeShared() {
        synchronized (shared) {
            List<Map<String, Object>> out = new ArrayList<>(shared);
            shared.clear();
            return out;
        }
    }

    /** A picked URI as a send item for the UI ({kind, path: the URI, name}); keeps read access across restarts. */
    Map<String, Object> describe(Uri uri, boolean tree) {
        try {
            ctx.getContentResolver().takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION);
        } catch (SecurityException ignored) {
            // not persistable (e.g. a share grant): fine while the app runs
        }
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("kind", tree ? "dir" : "file");
        m.put("path", uri.toString());
        Uri named = tree ? DocumentsContract.buildDocumentUriUsingTree(uri, DocumentsContract.getTreeDocumentId(uri)) : uri;
        m.put("name", displayName(named));
        return m;
    }

    String displayName(Uri uri) {
        try (Cursor c = ctx.getContentResolver().query(uri, new String[] {OpenableColumns.DISPLAY_NAME}, null, null, null)) {
            if (c != null && c.moveToFirst() && !c.isNull(0)) return c.getString(0);
        } catch (RuntimeException ignored) {
            // fall back to the URI's last segment
        }
        String last = uri.getLastPathSegment();
        return last == null ? "file" : last;
    }

    /** "Share → MeshDrop": queues the shared files/text for the Devices page. */
    /** A meshdrop://join link the app was opened with, until a join is attempted. */
    private volatile String joinLink;

    void acceptShare(Activity a, Intent intent) {
        if (intent == null) return;
        String action = intent.getAction();
        Uri data = intent.getData();
        if (Intent.ACTION_VIEW.equals(action) && data != null && "meshdrop".equals(data.getScheme()) && "join".equals(data.getHost())) {
            String link = data.toString();
            intent.setAction(null); // handled once, not again on recreation
            // Never joined silently: the link only pre-fills the join box; the user confirms.
            if (link.length() <= 4096) {
                joinLink = link;
                if (controller != null) controller.refresh();
            }
            return;
        }
        List<Map<String, Object>> items = new ArrayList<>();
        if (Intent.ACTION_SEND.equals(action)) {
            Uri u = streamExtra(intent);
            if (!shareable(u)) u = null;
            if (u != null) items.add(describe(u, false));
            CharSequence t = intent.getCharSequenceExtra(Intent.EXTRA_TEXT);
            if (u == null && t != null) {
                Map<String, Object> m = new LinkedHashMap<>();
                m.put("kind", "text");
                m.put("text", t.toString());
                items.add(m);
            }
        } else if (Intent.ACTION_SEND_MULTIPLE.equals(action)) {
            ArrayList<Uri> us = streamListExtra(intent);
            if (us != null) for (Uri u : us) if (shareable(u)) items.add(describe(u, false));
        }
        intent.setAction(null); // handled once, not again on recreation
        if (!items.isEmpty()) addShared(items);
    }

    /**
     * Only content shared through another app's provider: a file:// link, or one into this app,
     * could make MeshDrop read (and send) its own private files, such as its keys.
     */
    private boolean shareable(Uri u) {
        if (u == null || !"content".equals(u.getScheme())) return false;
        String auth = u.getAuthority();
        return auth != null && !auth.startsWith(ctx.getPackageName());
    }

    @SuppressWarnings("deprecation") // the typed overloads are API 33+
    private static Uri streamExtra(Intent i) {
        return i.getParcelableExtra(Intent.EXTRA_STREAM);
    }

    @SuppressWarnings("deprecation")
    private static ArrayList<Uri> streamListExtra(Intent i) {
        return i.getParcelableArrayListExtra(Intent.EXTRA_STREAM);
    }

    /** Opens the system screen for one keep-alive step; falls back to the app's settings page. */
    @android.annotation.SuppressLint("BatteryLife") // keeping a file receiver reachable is the point of this step
    void keepAliveAction(Activity a, String id) {
        String pkg = ctx.getPackageName();
        Intent i;
        switch (id) {
            case "battery":
                i = new Intent(android.provider.Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:" + pkg));
                break;
            case "notifications":
                i = new Intent(android.provider.Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(android.provider.Settings.EXTRA_APP_PACKAGE, pkg);
                break;
            case "autostart":
                i = rom().equals("miui")
                        ? new Intent().setClassName("com.miui.securitycenter", "com.miui.permcenter.autostart.AutoStartManagementActivity")
                        : new Intent().setClassName("com.transsion.phonemaster", "com.cyin.himgr.autostart.AutoStartActivity");
                break;
            case "notification-access":
                i = new Intent(android.provider.Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS);
                break;
            case "extendo": {
                // Second screen: Extendo (its own app), or its download page when it is not installed.
                Intent launch = ctx.getPackageManager().getLaunchIntentForPackage(EXTENDO);
                i = launch != null ? launch : new Intent(Intent.ACTION_VIEW, Uri.parse(EXTENDO_PAGE));
                break;
            }
            case "battery-saver":
                i = new Intent().setClassName("com.miui.powerkeeper", "com.miui.powerkeeper.ui.HiddenAppsConfigActivity")
                        .putExtra("package_name", pkg).putExtra("package_label", "MeshDrop");
                break;
            default:
                throw new IllegalArgumentException("unknown step " + id);
        }
        Intent fallback = new Intent(android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + pkg));
        Intent chosen = i;
        a.runOnUiThread(() -> {
            try {
                a.startActivity(chosen);
            } catch (RuntimeException e) {
                a.startActivity(fallback); // the ROM moved that screen: the app page is the closest
            }
            if (controller != null) controller.refresh();
        });
    }

    // ---- M10: find my device, status, link handoff, notification replies ------------------------

    static final String EXTENDO = "io.github.hafijbge.extendo";
    static final String EXTENDO_PAGE = "https://github.com/Hafij-BGE/Second-monitor/releases/latest";
    private static final String RING = "ring";
    private static final int RING_NOTE = 7;
    private android.media.MediaPlayer ringer;
    private int alarmVolumeBefore = -1;

    @Override
    public synchronized void ring(boolean on) {
        android.media.AudioManager am = ctx.getSystemService(android.media.AudioManager.class);
        android.app.NotificationManager nm = ctx.getSystemService(android.app.NotificationManager.class);
        if (!on) {
            if (ringer != null) {
                ringer.stop();
                ringer.release();
                ringer = null;
            }
            if (alarmVolumeBefore >= 0) am.setStreamVolume(android.media.AudioManager.STREAM_ALARM, alarmVolumeBefore, 0);
            alarmVolumeBefore = -1;
            nm.cancel(RING_NOTE);
            return;
        }
        if (ringer != null) return;
        // The alarm stream plays even on silent; it goes to full volume while ringing and back after.
        alarmVolumeBefore = am.getStreamVolume(android.media.AudioManager.STREAM_ALARM);
        am.setStreamVolume(android.media.AudioManager.STREAM_ALARM, am.getStreamMaxVolume(android.media.AudioManager.STREAM_ALARM), 0);
        Uri tone = android.media.RingtoneManager.getDefaultUri(android.media.RingtoneManager.TYPE_ALARM);
        if (tone == null) tone = android.media.RingtoneManager.getDefaultUri(android.media.RingtoneManager.TYPE_RINGTONE);
        try {
            android.media.MediaPlayer p = new android.media.MediaPlayer();
            p.setAudioAttributes(new android.media.AudioAttributes.Builder().setUsage(android.media.AudioAttributes.USAGE_ALARM)
                    .setContentType(android.media.AudioAttributes.CONTENT_TYPE_SONIFICATION).build());
            p.setDataSource(ctx, tone);
            p.setLooping(true);
            p.prepare();
            p.start();
            ringer = p;
        } catch (java.io.IOException | RuntimeException e) {
            ringer = null;
        }
        if (nm.getNotificationChannel(RING) == null) {
            nm.createNotificationChannel(new android.app.NotificationChannel(RING, "Find my device", android.app.NotificationManager.IMPORTANCE_HIGH));
        }
        android.app.PendingIntent stop = android.app.PendingIntent.getBroadcast(ctx, 0, new Intent(ctx, RingStopReceiver.class), android.app.PendingIntent.FLAG_IMMUTABLE);
        android.app.PendingIntent open = android.app.PendingIntent.getActivity(ctx, 0, new Intent(ctx, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK), android.app.PendingIntent.FLAG_IMMUTABLE);
        android.app.Notification n = new android.app.Notification.Builder(ctx, RING)
                .setSmallIcon(R.drawable.ic_notify)
                .setContentTitle("Find my device")
                .setContentText("Another of your devices is looking for this one.")
                .setContentIntent(open)
                .setDeleteIntent(stop)
                .addAction(new android.app.Notification.Action.Builder(null, "Stop", stop).build())
                .setOngoing(true)
                .build();
        try {
            nm.notify(RING_NOTE, n);
        } catch (SecurityException ignored) {
            // notifications off: the sound still plays
        }
    }

    @Override
    public Map<String, Object> status() {
        Map<String, Object> m = new java.util.LinkedHashMap<>();
        try {
            android.os.BatteryManager bm = ctx.getSystemService(android.os.BatteryManager.class);
            Map<String, Object> b = new java.util.LinkedHashMap<>();
            b.put("level", (long) bm.getIntProperty(android.os.BatteryManager.BATTERY_PROPERTY_CAPACITY));
            b.put("charging", bm.isCharging());
            m.put("battery", b);
        } catch (RuntimeException ignored) {
            // unknown
        }
        try {
            android.os.StatFs fs = new android.os.StatFs(android.os.Environment.getDataDirectory().getPath());
            Map<String, Object> s = new java.util.LinkedHashMap<>();
            s.put("free", fs.getAvailableBytes());
            s.put("total", fs.getTotalBytes());
            m.put("storage", s);
        } catch (RuntimeException ignored) {
            // unknown
        }
        try {
            android.net.ConnectivityManager cm = ctx.getSystemService(android.net.ConnectivityManager.class);
            android.net.NetworkCapabilities nc = cm.getNetworkCapabilities(cm.getActiveNetwork());
            Map<String, Object> sig = new java.util.LinkedHashMap<>();
            if (nc != null && nc.hasTransport(android.net.NetworkCapabilities.TRANSPORT_WIFI)) {
                @SuppressWarnings("deprecation")
                int rssi = ((WifiManager) ctx.getSystemService(Context.WIFI_SERVICE)).getConnectionInfo().getRssi();
                sig.put("level", (long) Math.max(0, Math.min(4, (rssi + 100) / 12)));
                sig.put("type", "Wi-Fi");
            } else {
                android.telephony.SignalStrength ss = ctx.getSystemService(android.telephony.TelephonyManager.class).getSignalStrength();
                if (ss != null) {
                    sig.put("level", (long) ss.getLevel());
                    sig.put("type", "mobile");
                }
            }
            if (!sig.isEmpty()) m.put("signal", sig);
        } catch (RuntimeException ignored) {
            // no permission or no radio
        }
        return m;
    }

    private static final String LINKS = "links";

    @Override
    public void openUrl(String url) {
        Intent view = new Intent(Intent.ACTION_VIEW, Uri.parse(url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        if (MainActivity.resumed) {
            try {
                ctx.startActivity(view);
                return;
            } catch (RuntimeException ignored) {
                // no browser: the notification below
            }
        }
        // In the background Android does not let an app open a page by itself: offer it instead.
        android.app.NotificationManager nm = ctx.getSystemService(android.app.NotificationManager.class);
        if (nm.getNotificationChannel(LINKS) == null) {
            nm.createNotificationChannel(new android.app.NotificationChannel(LINKS, "Links from your devices", android.app.NotificationManager.IMPORTANCE_HIGH));
        }
        android.app.PendingIntent pi = android.app.PendingIntent.getActivity(ctx, nextNote, view, android.app.PendingIntent.FLAG_IMMUTABLE);
        android.app.Notification n = new android.app.Notification.Builder(ctx, LINKS)
                .setSmallIcon(R.drawable.ic_notify)
                .setContentTitle("Open link")
                .setContentText(url)
                .setContentIntent(pi)
                .setAutoCancel(true)
                .build();
        try {
            nm.notify(nextNote++, n);
        } catch (SecurityException ignored) {
            // notifications not allowed
        }
    }

    @Override
    public boolean replyNotification(String key, String text) {
        return NotifyListener.reply(key, text);
    }

    @Override
    public boolean notificationAccess() {
        String on = android.provider.Settings.Secure.getString(ctx.getContentResolver(), "enabled_notification_listeners");
        return on != null && on.contains(ctx.getPackageName() + "/");
    }

    // ---- M10b: PC sound here, this phone's camera and microphone on the PC ----------------------

    private MediaCast cast;

    private synchronized MediaCast cast() {
        if (cast == null) cast = new MediaCast(ctx);
        return cast;
    }

    @Override
    public void mediaStarting(String kind) throws java.io.IOException {
        cast().starting(kind);
    }

    @Override
    public void mediaStopped(String kind) {
        cast().stopped(kind);
    }

    @Override
    public void playAudio(java.io.InputStream in, java.util.function.BooleanSupplier stop) throws java.io.IOException {
        cast().play(in, stop);
    }

    @Override
    public void captureCamera(java.io.OutputStream out, java.util.function.BooleanSupplier stop, boolean back) throws java.io.IOException {
        cast().camera(out, stop, back);
    }

    @Override
    public void captureMic(java.io.OutputStream out, java.util.function.BooleanSupplier stop) throws java.io.IOException {
        cast().mic(out, stop);
    }

    @Override
    public void captureSound(java.io.OutputStream out, java.util.function.BooleanSupplier stop) throws java.io.IOException {
        cast().sound(out, stop);
    }

    @Override
    public io.github.hafijbge.meshdrop.engine.bt.OpusRtp.Codec opusEncoder(int channels, int bitrate) throws java.io.IOException {
        return OpusCodecs.encoder(channels, bitrate);
    }

    @Override
    public io.github.hafijbge.meshdrop.engine.bt.OpusRtp.Codec opusDecoder(int channels) throws java.io.IOException {
        return OpusCodecs.decoder(channels);
    }

    // ---- M14: hotspots ----

    private Hotspots hotspots;

    private synchronized Hotspots hotspots() {
        if (hotspots == null) hotspots = new Hotspots(ctx);
        return hotspots;
    }

    @Override
    public Map<String, Object> hotspotHost() throws IOException {
        return hotspots().host();
    }

    @Override
    public void hotspotJoin(String ssid, String psk) throws IOException {
        hotspots().join(ssid, psk);
    }

    @Override
    public void hotspotStop() {
        hotspots().stop();
    }

    // ---- M11 ----

    @Override
    public String displayName(String ref) {
        if (!ref.startsWith("content://")) return Platform.super.displayName(ref);
        try (android.database.Cursor c = ctx.getContentResolver().query(Uri.parse(ref), new String[] {android.provider.OpenableColumns.DISPLAY_NAME}, null, null, null)) {
            if (c != null && c.moveToFirst()) return c.getString(0);
        } catch (RuntimeException ignored) {
            // no name
        }
        return "file";
    }

    @Override
    public void deleteReceived(String ref) {
        if (!ref.startsWith("content://")) {
            Platform.super.deleteReceived(ref);
            return;
        }
        try {
            ctx.getContentResolver().delete(Uri.parse(ref), null, null); // our own MediaStore entry
        } catch (RuntimeException ignored) {
            // gone already, or no longer ours
        }
    }
}
