package io.github.hafijbge.meshdrop.addon.share;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Typeface;
import android.net.ConnectivityManager;
import android.net.LinkAddress;
import android.net.LinkProperties;
import android.net.Network;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.text.format.Formatter;
import android.util.Log;
import android.view.View;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import io.github.hafijbge.meshdrop.picker.PickerActivity;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Sends what another app shared (or what is picked here) to a phone that is receiving in Xiaomi's
 * ShareMe: scan the QR code ShareMe shows, join its hotspot, then speak its protocol. Everything the
 * phones say to each other is written to the log below, since this is still being learned.
 */
public final class ShareActivity extends Activity {
    static final String TAG = "MeshDropShare";
    private static final int REQ_SCAN = 1;
    private static final int REQ_PICK = 2;
    private static final int REQ_PERMS = 3;

    private final List<Shared> items = new ArrayList<>();
    private final ExecutorService work = Executors.newSingleThreadExecutor();
    private TextView summary;
    private TextView status;
    private TextView log;
    private ScrollView logScroll;
    private Button scan;
    private WifiJoin wifi;
    private volatile boolean busy;

    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        wifi = new WifiJoin(this);
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setPadding(40, 40, 40, 40);
        TextView title = new TextView(this);
        title.setText("Send to a ShareMe phone");
        title.setTextSize(20);
        title.setTypeface(Typeface.DEFAULT_BOLD);
        root.addView(title);
        summary = new TextView(this);
        summary.setPadding(0, 16, 0, 16);
        root.addView(summary);
        LinearLayout buttons = new LinearLayout(this);
        Button pick = new Button(this);
        pick.setText("Choose files");
        pick.setOnClickListener(v -> pickFiles());
        buttons.addView(pick);
        scan = new Button(this);
        scan.setText("Scan ShareMe QR");
        scan.setOnClickListener(v -> startScan());
        buttons.addView(scan);
        root.addView(buttons);
        status = new TextView(this);
        status.setPadding(0, 16, 0, 16);
        status.setText("On the other phone open ShareMe and tap Receive, then scan its QR code here.");
        root.addView(status);
        logScroll = new ScrollView(this);
        log = new TextView(this);
        log.setTypeface(Typeface.MONOSPACE);
        log.setTextSize(11);
        log.setTextIsSelectable(true);
        logScroll.addView(log);
        root.addView(logScroll, new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f));
        // the system-bar insets replace a view's own padding, so they go on a wrapper
        android.widget.FrameLayout frame = new android.widget.FrameLayout(this);
        frame.setFitsSystemWindows(true);
        frame.addView(root);
        setContentView(frame);
        take(getIntent());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        if (!busy) take(intent);
    }

    @Override
    protected void onDestroy() {
        work.shutdownNow();
        wifi.close();
        super.onDestroy();
    }

    /** Collects the files (and text) of a share intent. */
    private void take(Intent intent) {
        String action = intent.getAction();
        if (!Intent.ACTION_SEND.equals(action) && !Intent.ACTION_SEND_MULTIPLE.equals(action)) {
            showSummary();
            return;
        }
        items.clear();
        List<Uri> uris = new ArrayList<>();
        if (Intent.ACTION_SEND_MULTIPLE.equals(action)) {
            ArrayList<Uri> many = intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM);
            if (many != null) uris.addAll(many);
        } else {
            Uri one = intent.getParcelableExtra(Intent.EXTRA_STREAM);
            if (one != null) uris.add(one);
        }
        for (Uri u : uris) add(u);
        CharSequence text = intent.getCharSequenceExtra(Intent.EXTRA_TEXT);
        if (uris.isEmpty() && text != null && text.length() > 0) {
            try {
                File f = new File(getCacheDir(), "shared-text.txt");
                try (FileOutputStream out = new FileOutputStream(f)) {
                    out.write(text.toString().getBytes(StandardCharsets.UTF_8));
                }
                items.add(Shared.text(f));
            } catch (IOException e) {
                say("Could not keep the shared text: " + e.getMessage());
            }
        }
        showSummary();
    }

    private void add(Uri u) {
        Shared s = Shared.of(getContentResolver(), u);
        if (s == null) say("Skipped " + u + " (the app that shared it does not say its size).");
        else items.add(s);
    }

    private void showSummary() {
        if (items.isEmpty()) {
            summary.setText("Nothing to send yet. Share files to \"ShareMe (MeshDrop)\" from any app, or choose them here.");
            return;
        }
        long total = 0;
        StringBuilder b = new StringBuilder();
        for (Shared s : items) total += s.size;
        b.append(items.size()).append(items.size() == 1 ? " file, " : " files, ").append(Formatter.formatFileSize(this, total));
        for (int i = 0; i < Math.min(items.size(), 6); i++) b.append("\n• ").append(items.get(i).name);
        if (items.size() > 6) b.append("\n…");
        summary.setText(b);
    }

    private void pickFiles() {
        if (busy) return;
        // ShareMe's receiver takes at most 500 files in one list
        startActivityForResult(new Intent(this, PickerActivity.class).putExtra(PickerActivity.EXTRA_MAX, 500), REQ_PICK);
    }

    private void startScan() {
        if (busy) return;
        if (items.isEmpty()) {
            status.setText("Pick or share some files first.");
            return;
        }
        String perm = Build.VERSION.SDK_INT >= 33 ? Manifest.permission.NEARBY_WIFI_DEVICES : Manifest.permission.ACCESS_FINE_LOCATION;
        if (checkSelfPermission(perm) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[] {perm}, REQ_PERMS);
            return;
        }
        startActivityForResult(new Intent(this, ScannerActivity.class), REQ_SCAN);
    }

    @Override
    public void onRequestPermissionsResult(int code, String[] perms, int[] results) {
        if (code != REQ_PERMS) return;
        if (results.length > 0 && results[0] == PackageManager.PERMISSION_GRANTED) startScan();
        else status.setText("Joining the other phone's hotspot needs the Nearby devices permission.");
    }

    @Override
    protected void onActivityResult(int code, int result, Intent data) {
        super.onActivityResult(code, result, data);
        if (result != RESULT_OK || data == null) return;
        if (code == REQ_PICK) {
            ArrayList<Uri> uris = data.getParcelableArrayListExtra(PickerActivity.EXTRA_URIS);
            ArrayList<String> names = data.getStringArrayListExtra(PickerActivity.EXTRA_NAMES);
            ArrayList<String> mimes = data.getStringArrayListExtra(PickerActivity.EXTRA_MIMES);
            long[] sizes = data.getLongArrayExtra(PickerActivity.EXTRA_SIZES);
            if (uris == null || names == null || mimes == null || sizes == null) return;
            items.clear();
            for (int i = 0; i < uris.size(); i++) items.add(Shared.picked(uris.get(i), names.get(i), sizes[i], mimes.get(i)));
            showSummary();
        } else if (code == REQ_SCAN) {
            String text = data.getStringExtra(ScannerActivity.EXTRA_TEXT);
            if (text != null) onQr(text);
        }
    }

    private void onQr(String text) {
        ReceiverInfo info;
        try {
            info = ReceiverInfo.parse(text);
        } catch (IllegalArgumentException e) {
            say("QR: " + ReceiverInfo.describe(text));
            status.setText("That is not a ShareMe receive code: " + e.getMessage());
            return;
        }
        say("QR: " + ReceiverInfo.describe(text));
        say("Receiver: " + info);
        busy = true;
        scan.setEnabled(false);
        List<Shared> batch = new ArrayList<>(items);
        work.execute(() -> run(info, batch));
    }

    private void run(ReceiverInfo info, List<Shared> batch) {
        try {
            setStatus("Joining " + info.ssid + "…");
            Network n = wifi.join(info.ssid, info.psk);
            InetAddress self = ipv4On(n);
            say("Joined " + info.ssid + " as " + (self != null ? self.getHostAddress() : "?"));
            ShareMeSender sender = new ShareMeSender(info, self, this::say, this::setStatus);
            try (FileServer files = new FileServer(getContentResolver(), self, this::say, sender::sent)) {
                sender.send(files, batch);
            }
            setStatus("Sent " + batch.size() + (batch.size() == 1 ? " file." : " files."));
        } catch (Exception e) {
            say("Failed: " + e);
            Log.w(TAG, "send failed", e);
            setStatus("Did not work: " + e.getMessage());
        } finally {
            wifi.close();
            busy = false;
            runOnUiThread(() -> scan.setEnabled(true));
        }
    }

    private InetAddress ipv4On(Network n) {
        LinkProperties lp = getSystemService(ConnectivityManager.class).getLinkProperties(n);
        if (lp == null) return null;
        for (LinkAddress a : lp.getLinkAddresses()) if (a.getAddress() instanceof Inet4Address) return a.getAddress();
        return null;
    }

    private void setStatus(String s) {
        runOnUiThread(() -> status.setText(s));
    }

    /** Adds a line to the on-screen log and logcat. */
    void say(String line) {
        Log.i(TAG, line);
        runOnUiThread(() -> {
            log.append(line);
            log.append("\n");
            logScroll.post(() -> logScroll.fullScroll(View.FOCUS_DOWN));
        });
    }
}
