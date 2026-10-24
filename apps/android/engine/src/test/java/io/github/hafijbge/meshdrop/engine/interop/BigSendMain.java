package io.github.hafijbge.meshdrop.engine.interop;

import io.github.hafijbge.meshdrop.engine.identity.Identity;
import io.github.hafijbge.meshdrop.engine.identity.PlainKeyVault;
import io.github.hafijbge.meshdrop.engine.identity.X509;
import io.github.hafijbge.meshdrop.engine.send.Outbox;
import io.github.hafijbge.meshdrop.engine.send.PathSource;
import io.github.hafijbge.meshdrop.engine.send.Prepared;
import io.github.hafijbge.meshdrop.engine.send.SendItem;
import io.github.hafijbge.meshdrop.engine.send.SendResult;
import io.github.hafijbge.meshdrop.engine.send.Sender;
import java.io.File;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;

/** Run in a JVM with a small heap: sends one big file, exits 0 on done. */
public final class BigSendMain {
    public static void main(String[] a) throws Exception {
        Identity me = Identity.loadOrCreate(new File(a[0]), new PlainKeyVault());
        Sender.Target t = new Sender.Target(a[1], "127.0.0.1", Integer.parseInt(a[2]), X509.publicKey(Files.readAllBytes(Path.of(a[3]))));
        Sender.Options o = new Sender.Options();
        o.outbox = new Outbox(new File(a[0], "outbox"));
        o.resolver = PathSource.RESOLVER;
        SendResult r = Sender.sendTo(me, t, Prepared.of(List.of(SendItem.file(PathSource.file(Path.of(a[4])))), null), o);
        System.out.println(r.status + " " + r.error + " maxHeap=" + Runtime.getRuntime().maxMemory());
        System.exit("done".equals(r.status) ? 0 : 1);
    }
}
