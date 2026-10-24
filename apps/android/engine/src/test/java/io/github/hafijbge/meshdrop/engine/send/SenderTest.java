package io.github.hafijbge.meshdrop.engine.send;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

import java.io.File;
import java.nio.file.Files;
import java.util.List;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

public class SenderTest {
    @Rule public TemporaryFolder tmp = new TemporaryFolder();

    @Test
    public void preparedWalksAFolderLikeTheNodeEngine() throws Exception {
        File root = tmp.newFolder("trip");
        assertTrue(new File(root, "b/empty").mkdirs());
        Files.write(new File(root, "a.txt").toPath(), new byte[] {1});
        Files.write(new File(root, "b/c.jpg").toPath(), new byte[0]);
        Files.createSymbolicLink(new File(root, "link").toPath(), new File(root, "a.txt").toPath());
        Prepared p = Prepared.of(List.of(SendItem.dir(PathSource.tree(root.toPath())), SendItem.text("hi")), null);
        assertEquals(List.of("trip/a.txt", "trip/b/c.jpg"), p.paths());
        assertEquals(List.of("trip/b/empty"), p.dirs);
        assertEquals("image/jpeg", p.files.get(1).mime);
        assertEquals("hi", p.text);
        assertEquals(64, p.itemsKey.length());
    }

    @Test
    public void refusesNamesTheReceiverWouldRename() throws Exception {
        File f = new File(tmp.getRoot(), "con.txt");
        Files.write(f.toPath(), new byte[] {1});
        assertThrows(Sender.LocalPathError.class, () -> Prepared.of(List.of(SendItem.file(PathSource.file(f.toPath()))), null));
        File ok = new File(tmp.newFolder(), "ok");
        Files.write(ok.toPath(), new byte[] {2});
        assertThrows(IllegalArgumentException.class, () -> Prepared.of(List.of(SendItem.clipboard("x"), SendItem.file(PathSource.file(ok.toPath()))), null));
    }
}
