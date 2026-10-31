package io.github.hafijbge.meshdrop;

import io.github.hafijbge.meshdrop.engine.util.Json;
import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/** The on-disk list of {@link WifiProfile}s: a sealed JSON array at home/wifi-profiles.bin (M1). */
final class WifiStore {
    private final File file;

    WifiStore(File file) {
        this.file = file;
    }

    synchronized List<WifiProfile> load() {
        if (!file.exists()) return new ArrayList<>();
        try {
            byte[] plain = WifiVault.open(Files.readAllBytes(file.toPath()));
            Object parsed = Json.parse(new String(plain, StandardCharsets.UTF_8));
            List<WifiProfile> out = new ArrayList<>();
            if (parsed instanceof List) {
                for (Object it : (List<?>) parsed) {
                    if (it instanceof Map) out.add(WifiProfile.fromMap((Map<?, ?>) it));
                }
            }
            return out;
        } catch (IOException | RuntimeException e) {
            // Unreadable (a new Keystore key, or corruption): start empty rather than crash the bridge.
            return new ArrayList<>();
        }
    }

    synchronized void save(List<WifiProfile> profiles) throws IOException {
        List<Object> arr = new ArrayList<>();
        for (WifiProfile p : profiles) arr.add(p.toMap());
        byte[] sealed = WifiVault.seal(Json.stringify(arr).getBytes(StandardCharsets.UTF_8));
        File parent = file.getParentFile();
        if (parent != null) parent.mkdirs();
        File tmp = new File(parent, file.getName() + ".tmp");
        Files.write(tmp.toPath(), sealed);
        if (!tmp.renameTo(file)) {
            Files.write(file.toPath(), sealed); // same-filesystem rename failed: write in place
            tmp.delete();
        }
    }
}
