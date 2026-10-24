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
    public boolean notifications = true;

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
        m.put("notifications", notifications);
        return m;
    }
}
