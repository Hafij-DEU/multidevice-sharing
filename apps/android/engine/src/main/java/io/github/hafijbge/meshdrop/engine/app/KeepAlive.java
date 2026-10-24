package io.github.hafijbge.meshdrop.engine.app;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * The "Keep MeshDrop alive" checklist (spec §9): which ROM this is, and the steps that stop it from
 * killing MeshDrop in the background. The Android shell opens the matching system screens.
 */
public final class KeepAlive {
    private KeepAlive() {}

    /** miui (MIUI/HyperOS), hios (Tecno/Infinix/itel) or stock, from system properties and Build.MANUFACTURER. */
    public static String rom(Map<String, String> props, String manufacturer) {
        if (set(props, "ro.miui.ui.version.name") || set(props, "ro.mi.os.version.name")) return "miui";
        String m = manufacturer == null ? "" : manufacturer.toLowerCase(Locale.ROOT);
        if (set(props, "ro.tranos.type") || set(props, "ro.os.hios.version") || m.equals("tecno") || m.equals("infinix") || m.equals("itel")) return "hios";
        return "stock";
    }

    private static boolean set(Map<String, String> props, String k) {
        String v = props.get(k);
        return v != null && !v.trim().isEmpty();
    }

    private static Map<String, Object> step(String id, String label, boolean done) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("id", id);
        m.put("label", label);
        if (done) m.put("done", true);
        return m;
    }

    public static List<Map<String, Object>> steps(String rom, boolean batteryUnrestricted, boolean notificationsAllowed) {
        List<Map<String, Object>> out = new ArrayList<>();
        out.add(step("battery", "Battery: let MeshDrop run without restrictions", batteryUnrestricted));
        out.add(step("notifications", "Allow notifications (received files, the background service)", notificationsAllowed));
        if (rom.equals("miui")) {
            out.add(step("autostart", "Autostart: turn MeshDrop on (Security → Permissions → Autostart)", false));
            out.add(step("battery-saver", "Battery saver: set MeshDrop to \"No restrictions\"; also lock it in Recents", false));
        } else if (rom.equals("hios")) {
            out.add(step("autostart", "Phone Master → Auto-start: allow MeshDrop, and remove it from background freezing", false));
        }
        return out;
    }

    /** The AppState.keepAlive object. */
    public static Map<String, Object> state(String rom, boolean batteryUnrestricted, boolean notificationsAllowed) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("batteryUnrestricted", batteryUnrestricted);
        m.put("rom", rom);
        m.put("steps", new ArrayList<Object>(steps(rom, batteryUnrestricted, notificationsAllowed)));
        return m;
    }
}
