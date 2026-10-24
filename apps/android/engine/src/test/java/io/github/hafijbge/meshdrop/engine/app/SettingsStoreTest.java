package io.github.hafijbge.meshdrop.engine.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertThrows;

import java.io.File;
import java.util.Map;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

/** The validation rules of apps/desktop/src/main/settings.ts. */
public class SettingsStoreTest {
    @Rule public TemporaryFolder tmp = new TemporaryFolder();

    @Test
    public void validatesLikeTheDesktopAndKeepsTheOldValues() throws Exception {
        File f = new File(tmp.getRoot(), "s.json");
        SettingsStore s = new SettingsStore(f, Settings.defaults("Pixel 8"));
        assertEquals(53318, s.get().port);
        assertThrows(SettingsStore.SettingsError.class, () -> s.set(Map.of("alias", "‮evil")));
        assertThrows(SettingsStore.SettingsError.class, () -> s.set(Map.of("alias", "")));
        assertThrows(SettingsStore.SettingsError.class, () -> s.set(Map.of("alias", "x".repeat(65))));
        assertThrows(SettingsStore.SettingsError.class, () -> s.set(Map.of("port", 80L)));
        assertThrows(SettingsStore.SettingsError.class, () -> s.set(Map.of("port", 70000L)));
        assertThrows(SettingsStore.SettingsError.class, () -> s.set(Map.of("notifications", "yes")));
        assertThrows(SettingsStore.SettingsError.class, () -> s.set(Map.of("bogus", true)));
        assertEquals("Pixel 8", s.get().alias);
        s.set(Map.of("alias", "Phone ✓", "notifications", false));
        SettingsStore again = new SettingsStore(f, Settings.defaults("x"));
        assertEquals("Phone ✓", again.get().alias);
        assertEquals(false, again.get().notifications);
    }
}
