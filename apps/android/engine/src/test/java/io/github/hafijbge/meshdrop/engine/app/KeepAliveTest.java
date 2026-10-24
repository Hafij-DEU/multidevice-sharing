package io.github.hafijbge.meshdrop.engine.app;

import static org.junit.Assert.assertEquals;

import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.stream.Collectors;
import org.junit.Test;

public class KeepAliveTest {
    static List<String> ids(String rom) {
        return KeepAlive.steps(rom, false, false).stream().map(s -> (String) s.get("id")).collect(Collectors.toList());
    }

    @Test
    public void detectsTheRom() {
        Map<String, String> miui = new HashMap<>();
        miui.put("ro.miui.ui.version.name", "V140");
        assertEquals("miui", KeepAlive.rom(miui, "Xiaomi"));
        Map<String, String> hyper = new HashMap<>();
        hyper.put("ro.mi.os.version.name", "OS2.0");
        assertEquals("miui", KeepAlive.rom(hyper, "Xiaomi"));
        assertEquals("hios", KeepAlive.rom(new HashMap<>(), "TECNO"));
        Map<String, String> tranos = new HashMap<>();
        tranos.put("ro.tranos.type", "hios");
        assertEquals("hios", KeepAlive.rom(tranos, "Unknown"));
        assertEquals("stock", KeepAlive.rom(new HashMap<>(), "Google"));
    }

    @Test
    public void listsTheStepsPerRom() {
        assertEquals(List.of("battery", "notifications", "autostart", "battery-saver"), ids("miui"));
        assertEquals(List.of("battery", "notifications", "autostart"), ids("hios"));
        assertEquals(List.of("battery", "notifications"), ids("stock"));
        Map<String, Object> battery = KeepAlive.steps("stock", true, false).get(0);
        assertEquals(true, battery.get("done"));
    }
}
