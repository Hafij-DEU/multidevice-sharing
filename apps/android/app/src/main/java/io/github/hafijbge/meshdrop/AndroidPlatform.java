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

    @Override
    public void decorate(Map<String, Object> state) {
        state.put("platform", "android");
        synchronized (shared) {
            state.put("sharedPending", (long) shared.size());
        }
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
    void acceptShare(Activity a, Intent intent) {
        if (intent == null) return;
        String action = intent.getAction();
        List<Map<String, Object>> items = new ArrayList<>();
        if (Intent.ACTION_SEND.equals(action)) {
            Uri u = streamExtra(intent);
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
            if (us != null) for (Uri u : us) items.add(describe(u, false));
        }
        intent.setAction(null); // handled once, not again on recreation
        if (!items.isEmpty()) addShared(items);
    }

    @SuppressWarnings("deprecation") // the typed overloads are API 33+
    private static Uri streamExtra(Intent i) {
        return i.getParcelableExtra(Intent.EXTRA_STREAM);
    }

    @SuppressWarnings("deprecation")
    private static ArrayList<Uri> streamListExtra(Intent i) {
        return i.getParcelableArrayListExtra(Intent.EXTRA_STREAM);
    }

    /** Opens the system screen for one keep-alive step (Task 11). */
    void keepAliveAction(Activity a, String id) {
        throw new IllegalStateException("not available yet");
    }
}
