package io.github.hafijbge.meshdrop;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.NetworkRequest;
import android.os.IBinder;
import java.io.IOException;

/**
 * Keeps MeshDrop reachable: a foreground service of type connectedDevice (no daily time cap on
 * Android 15) that owns the engine, with an ongoing low-importance notification carrying
 * "Send clipboard" and "Pause/Resume receiving". Wi-Fi changes re-announce and re-probe.
 */
public final class MeshService extends Service {
    static final String CHANNEL = "service";
    static final String ACTION_PAUSE = "io.github.hafijbge.meshdrop.PAUSE";
    static final String ACTION_RESUME = "io.github.hafijbge.meshdrop.RESUME";
    private static final int NOTE_ID = 1;
    private ConnectivityManager.NetworkCallback netCallback;

    static void start(Context ctx) {
        ctx.startForegroundService(new Intent(ctx, MeshService.class));
    }

    @Override
    public void onCreate() {
        super.onCreate();
        NotificationManager nm = getSystemService(NotificationManager.class);
        NotificationChannel ch = new NotificationChannel(CHANNEL, "Receiving", NotificationManager.IMPORTANCE_LOW);
        ch.setShowBadge(false);
        nm.createNotificationChannel(ch);
        startForeground(NOTE_ID, notification(true), ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE);
        Core core = ((MeshApp) getApplication()).core();
        new Thread(() -> {
            try {
                core.ensureStarted();
                core.controller.refresh();
            } catch (IOException e) {
                // shown in the UI as state.error / "Starting…"
            }
        }, "meshdrop-service-start").start();
        ConnectivityManager cm = getSystemService(ConnectivityManager.class);
        netCallback = new ConnectivityManager.NetworkCallback() {
            @Override
            public void onAvailable(Network network) {
                if (core.started()) core.controller.networkChanged();
            }

            @Override
            public void onLost(Network network) {
                if (core.started()) core.controller.networkChanged();
            }
        };
        cm.registerNetworkCallback(new NetworkRequest.Builder().addTransportType(NetworkCapabilities.TRANSPORT_WIFI).build(), netCallback);
    }

    private Notification notification(boolean receiving) {
        PendingIntent open = PendingIntent.getActivity(this, 0, new Intent(this, MainActivity.class), PendingIntent.FLAG_IMMUTABLE);
        PendingIntent clip = PendingIntent.getActivity(this, 1, new Intent(this, ClipboardSendActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
                PendingIntent.FLAG_IMMUTABLE);
        Intent toggle = new Intent(this, MeshService.class).setAction(receiving ? ACTION_PAUSE : ACTION_RESUME);
        PendingIntent pause = PendingIntent.getService(this, 2, toggle, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        return new Notification.Builder(this, CHANNEL)
                .setSmallIcon(R.drawable.ic_notify)
                .setContentTitle("MeshDrop")
                .setContentText(receiving ? "Ready to receive on this network" : "Receiving paused")
                .setContentIntent(open)
                .setOngoing(true)
                .setShowWhen(false)
                .addAction(new Notification.Action.Builder(null, "Send clipboard", clip).build())
                .addAction(new Notification.Action.Builder(null, receiving ? "Pause receiving" : "Resume", pause).build())
                .build();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String a = intent == null ? null : intent.getAction();
        if (ACTION_PAUSE.equals(a) || ACTION_RESUME.equals(a)) {
            boolean on = ACTION_RESUME.equals(a);
            ((MeshApp) getApplication()).core().controller.setReceiving(on);
            getSystemService(NotificationManager.class).notify(NOTE_ID, notification(on));
        }
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        if (netCallback != null) getSystemService(ConnectivityManager.class).unregisterNetworkCallback(netCallback);
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
