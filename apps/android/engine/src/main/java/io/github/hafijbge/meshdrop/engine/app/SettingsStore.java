package io.github.hafijbge.meshdrop.engine.app;

import io.github.hafijbge.meshdrop.engine.util.Atomic;
import io.github.hafijbge.meshdrop.engine.util.Json;
import io.github.hafijbge.meshdrop.engine.util.Io;
import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.Map;
import java.util.regex.Pattern;

/** android-settings.json (0600): every change is validated as a whole, like apps/desktop/src/main/settings.ts. */
public final class SettingsStore {
    private static final Pattern UNPRINTABLE = Pattern.compile("[\\u0000-\\u001f\\u007f-\\u009f\\u061c\\u200e\\u200f\\u2028\\u2029\\u202a-\\u202e\\u2066-\\u2069]");

    public static final class SettingsError extends IllegalArgumentException {
        public SettingsError(String message) {
            super(message);
        }
    }

    private final File file;
    private Settings current;

    public SettingsStore(File file, Settings defaults) {
        this.file = file;
        Settings s = defaults.copy();
        try {
            Object j = Json.parse(Io.readString(file.toPath()));
            if (j instanceof Map) {
                @SuppressWarnings("unchecked")
                Map<String, Object> m = (Map<String, Object>) j;
                for (Map.Entry<String, Object> e : m.entrySet()) {
                    try {
                        apply(s, e.getKey(), e.getValue());
                    } catch (SettingsError ignored) {
                        // a bad field keeps its default
                    }
                }
            }
            validate(s);
        } catch (IOException | RuntimeException e) {
            s = defaults.copy();
        }
        current = s;
    }

    public synchronized Settings get() {
        return current.copy();
    }

    private static void apply(Settings s, String k, Object v) {
        switch (k) {
            case "alias":
                if (!(v instanceof String)) throw new SettingsError("Invalid value for alias.");
                s.alias = (String) v;
                break;
            case "inbox":
                if (!Settings.ANDROID_INBOX.equals(v)) throw new SettingsError("On Android, received files always go to Download/MeshDrop for now.");
                break;
            case "port":
                if (!(v instanceof Long) && !(v instanceof Integer)) throw new SettingsError("Invalid value for port.");
                long p = ((Number) v).longValue();
                if (p < 0 || p > 65535) throw new SettingsError("The port must be between 1024 and 65535 (or 0 for any free port).");
                s.port = (int) p;
                break;
            case "discovery":
            case "autostart":
            case "startHidden":
            case "closeToTray":
            case "clipboardReceive":
            case "clipboardSync":
            case "notifications":
                if (!(v instanceof Boolean)) throw new SettingsError("Invalid value for " + k + ".");
                boolean b = (Boolean) v;
                if (k.equals("discovery")) s.discovery = b;
                else if (k.equals("autostart")) s.autostart = b;
                else if (k.equals("startHidden")) s.startHidden = b;
                else if (k.equals("closeToTray")) s.closeToTray = b;
                else if (k.equals("clipboardReceive")) s.clipboardReceive = b;
                else if (k.equals("clipboardSync")) s.clipboardSync = b;
                else s.notifications = b;
                break;
            case "backupTarget":
                if (!(v instanceof String) || !((String) v).matches("^([0-9a-f]{64})?$")) throw new SettingsError("Invalid value for backupTarget.");
                s.backupTarget = (String) v;
                break;
            case "backupSince":
                if (!(v instanceof Long) || (Long) v < 0) throw new SettingsError("Invalid value for backupSince.");
                s.backupSince = (Long) v;
                break;
            case "notifyTo":
            case "remoteFrom": {
                if (!(v instanceof java.util.List) || ((java.util.List<?>) v).size() > 64) throw new SettingsError("Invalid value for " + k + ".");
                java.util.List<String> ids = new java.util.ArrayList<>();
                for (Object o : (java.util.List<?>) v) {
                    if (!(o instanceof String) || !((String) o).matches("^[0-9a-f]{64}$")) throw new SettingsError("Invalid value for " + k + ".");
                    if (!ids.contains(o)) ids.add((String) o);
                }
                if (k.equals("notifyTo")) s.notifyTo = java.util.Collections.unmodifiableList(ids);
                else s.remoteFrom = java.util.Collections.unmodifiableList(ids);
                break;
            }
            case "openLinks":
            case "phoneNotifications":
            case "sendReceipts":
            case "printFromDevices":
            case "sortInbox":
                if (!(v instanceof Boolean)) throw new SettingsError("Invalid value for " + k + ".");
                if (k.equals("openLinks")) s.openLinks = (Boolean) v;
                else if (k.equals("phoneNotifications")) s.phoneNotifications = (Boolean) v;
                else if (k.equals("sendReceipts")) s.sendReceipts = (Boolean) v;
                else if (k.equals("printFromDevices")) s.printFromDevices = (Boolean) v;
                else s.sortInbox = (Boolean) v;
                break;
            case "cleanupDays": {
                if (!(v instanceof Long) && !(v instanceof Integer)) throw new SettingsError("Invalid value for cleanupDays.");
                long d = ((Number) v).longValue();
                if (d < 0 || d > 3650) throw new SettingsError("Clean-up must be 0 (never) or up to 3650 days.");
                s.cleanupDays = (int) d;
                break;
            }
            case "guestMinutes":
                if (!(v instanceof Long) && !(v instanceof Integer)) throw new SettingsError("Invalid value for guestMinutes.");
                long gm = ((Number) v).longValue();
                if (gm < 5 || gm > 1440) throw new SettingsError("A guest link works for 5 minutes to 24 hours.");
                s.guestMinutes = (int) gm;
                break;
            default:
                throw new SettingsError("Unknown setting " + k + ".");
        }
    }

    private static void validate(Settings s) {
        if (s.alias == null || s.alias.isEmpty() || s.alias.length() > 64 || UNPRINTABLE.matcher(s.alias).find()) {
            throw new SettingsError("The device name must be 1–64 characters, without control characters.");
        }
        if (s.port != 0 && (s.port < 1024 || s.port > 65535)) throw new SettingsError("The port must be between 1024 and 65535 (or 0 for any free port).");
    }

    /** The settings `patch` would produce, validated; nothing is saved. */
    public synchronized Settings preview(Map<String, Object> patch) {
        Settings next = current.copy();
        for (Map.Entry<String, Object> e : patch.entrySet()) apply(next, e.getKey(), e.getValue());
        validate(next);
        return next;
    }

    public synchronized Settings set(Map<String, Object> patch) throws IOException {
        Settings next = preview(patch);
        Atomic.write(file, Json.stringify(next.toMap()).getBytes(StandardCharsets.UTF_8));
        current = next;
        return next.copy();
    }

    /** Restores a previous value as a whole (rollback after a failed restart). */
    public synchronized void restore(Settings s) throws IOException {
        Atomic.write(file, Json.stringify(s.toMap()).getBytes(StandardCharsets.UTF_8));
        current = s.copy();
    }
}
