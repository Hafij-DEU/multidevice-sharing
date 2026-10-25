package io.github.hafijbge.meshdrop;

import android.app.Notification;
import android.app.PendingIntent;
import android.app.RemoteInput;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Bundle;
import android.service.notification.NotificationListenerService;
import android.service.notification.StatusBarNotification;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * M10: forwards this phone's notifications to the PCs picked in Settings (notifyTo), and answers them
 * from the PC through the notification's own reply action (messages and SMS apps have one), so no SMS
 * permission is needed. Android asks the user once for notification access.
 */
public final class NotifyListener extends NotificationListenerService {
    private static volatile NotifyListener live;
    /** What was last forwarded per key: an update with the same text is not sent again. */
    private final Map<String, String> sent = new ConcurrentHashMap<>();

    @Override
    public void onListenerConnected() {
        live = this;
    }

    @Override
    public void onListenerDisconnected() {
        live = null;
    }

    private MeshApp app() {
        return (MeshApp) getApplication();
    }

    @Override
    public void onNotificationPosted(StatusBarNotification sbn) {
        if (sbn.getPackageName().equals(getPackageName())) return;
        Notification n = sbn.getNotification();
        if ((n.flags & (Notification.FLAG_ONGOING_EVENT | Notification.FLAG_GROUP_SUMMARY | Notification.FLAG_FOREGROUND_SERVICE)) != 0) return;
        Bundle ex = n.extras;
        CharSequence title = ex.getCharSequence(Notification.EXTRA_TITLE);
        CharSequence text = ex.getCharSequence(Notification.EXTRA_BIG_TEXT);
        if (text == null) text = ex.getCharSequence(Notification.EXTRA_TEXT);
        if (title == null && text == null) return;
        String sig = title + "\n" + text;
        if (sig.equals(sent.put(sbn.getKey(), sig))) return;
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("key", sbn.getKey());
        m.put("app", label(sbn.getPackageName()));
        m.put("title", title == null ? "" : title.toString());
        m.put("text", text == null ? "" : text.toString());
        m.put("time", sbn.getPostTime());
        m.put("replyable", replyAction(n) != null);
        app().core().controller.forwardNotification(m);
    }

    @Override
    public void onNotificationRemoved(StatusBarNotification sbn) {
        if (sent.remove(sbn.getKey()) != null) app().core().controller.forwardNotificationRemoved(sbn.getKey());
    }

    private String label(String pkg) {
        try {
            PackageManager pm = getPackageManager();
            return pm.getApplicationLabel(pm.getApplicationInfo(pkg, 0)).toString();
        } catch (PackageManager.NameNotFoundException e) {
            return pkg;
        }
    }

    private static Notification.Action replyAction(Notification n) {
        if (n.actions == null) return null;
        for (Notification.Action a : n.actions) {
            RemoteInput[] ri = a.getRemoteInputs();
            if (ri != null) for (RemoteInput r : ri) if (r.getAllowFreeFormInput()) return a;
        }
        return null;
    }

    /** Answers the notification `key` with `text` through its reply action; false when it is gone. */
    static boolean reply(String key, String text) {
        NotifyListener l = live;
        if (l == null) return false;
        StatusBarNotification[] found;
        try {
            found = l.getActiveNotifications(new String[] {key});
        } catch (RuntimeException e) {
            return false;
        }
        if (found == null || found.length == 0) return false;
        Notification.Action a = replyAction(found[0].getNotification());
        if (a == null) return false;
        Intent fill = new Intent();
        Bundle results = new Bundle();
        for (RemoteInput r : a.getRemoteInputs()) results.putCharSequence(r.getResultKey(), text);
        RemoteInput.addResultsToIntent(a.getRemoteInputs(), fill, results);
        try {
            a.actionIntent.send(l, 0, fill);
            return true;
        } catch (PendingIntent.CanceledException e) {
            return false;
        }
    }
}
