package io.github.hafijbge.meshdrop.engine.app;

import java.util.LinkedHashMap;
import java.util.Map;

/** The app settings, the same shape as the desktop's Settings (apps/desktop/src/shared/api.ts). */
public final class Settings implements Cloneable {
    public static final String ANDROID_INBOX = "Download/MeshDrop";

    public String alias;
    public String inbox = ANDROID_INBOX;
    public int port = 53318;
    public boolean discovery = true;
    public boolean autostart = false;
    public boolean startHidden = false;
    public boolean closeToTray = true;
    public boolean clipboardReceive = true;
    /** Copying text sends it to the online trusted devices (Android: while MeshDrop is in front). */
    public boolean clipboardSync = false;
    public boolean notifications = true;
    /** How long a guest link works, in minutes (5..1440). */
    public int guestMinutes = 60;
    /** Photo backup (Android): the PC that gets new camera photos ("": off), and the last MediaStore id handed over. */
    public String backupTarget = "";
    public long backupSince = 0;
    /** M10: the devices this phone forwards its notifications to. */
    public java.util.List<String> notifyTo = java.util.Collections.emptyList();
    /** M10: links sent with "Open on device" open here. */
    public boolean openLinks = true;
    /** M10 (desktop meaning; kept for the shared settings shape). */
    public java.util.List<String> remoteFrom = java.util.Collections.emptyList();
    public boolean phoneNotifications = true;

    public static Settings defaults(String alias) {
        Settings s = new Settings();
        s.alias = alias.length() > 64 ? alias.substring(0, 64) : alias;
        return s;
    }

    public Settings copy() {
        try {
            return (Settings) clone();
        } catch (CloneNotSupportedException e) {
            throw new IllegalStateException(e);
        }
    }

    public Map<String, Object> toMap() {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("alias", alias);
        m.put("inbox", inbox);
        m.put("port", (long) port);
        m.put("discovery", discovery);
        m.put("autostart", autostart);
        m.put("startHidden", startHidden);
        m.put("closeToTray", closeToTray);
        m.put("clipboardReceive", clipboardReceive);
        m.put("clipboardSync", clipboardSync);
        m.put("notifications", notifications);
        m.put("guestMinutes", (long) guestMinutes);
        m.put("backupTarget", backupTarget);
        m.put("backupSince", backupSince);
        m.put("notifyTo", new java.util.ArrayList<Object>(notifyTo));
        m.put("openLinks", openLinks);
        m.put("remoteFrom", new java.util.ArrayList<Object>(remoteFrom));
        m.put("phoneNotifications", phoneNotifications);
        return m;
    }
}
