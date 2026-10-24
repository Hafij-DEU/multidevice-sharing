package io.github.hafijbge.meshdrop.engine.app;

import static org.junit.Assert.assertEquals;

import java.io.File;
import java.util.List;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

public class HistoryStoreTest {
    @Rule public TemporaryFolder tmp = new TemporaryFolder();

    @Test
    public void keepsTheNewestRecordsUpToTheCapAndReloads() throws Exception {
        File f = new File(tmp.getRoot(), "desktop-history.json");
        HistoryStore h = new HistoryStore(f, 3);
        for (int i = 0; i < 5; i++) h.addReceived(i, "ab".repeat(32), "a" + i, List.of("/x/" + i), null, false);
        assertEquals(List.of(4L, 3L, 2L), h.received().stream().map(r -> (Long) r.get("at")).collect(java.util.stream.Collectors.toList()));
        assertEquals("a4", new HistoryStore(f, 3).received().get(0).get("alias"));
    }
}
