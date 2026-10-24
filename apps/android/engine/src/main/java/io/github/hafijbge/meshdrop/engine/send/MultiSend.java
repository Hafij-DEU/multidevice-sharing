package io.github.hafijbge.meshdrop.engine.send;

import io.github.hafijbge.meshdrop.engine.identity.Identity;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;

/** One session per target, all concurrent; one failing never affects the others; results in target order. */
public final class MultiSend {
    private MultiSend() {}

    public static List<SendResult> send(Identity id, List<Sender.Target> targets, Prepared p, Sender.Options opts) {
        ExecutorService pool = Executors.newCachedThreadPool();
        try {
            List<Future<SendResult>> fs = new ArrayList<>();
            for (Sender.Target t : targets) fs.add(pool.submit(() -> Sender.sendTo(id, t, p, opts)));
            List<SendResult> out = new ArrayList<>();
            for (int i = 0; i < fs.size(); i++) {
                try {
                    out.add(fs.get(i).get());
                } catch (ExecutionException e) {
                    out.add(new SendResult(targets.get(i).deviceId, "failed", "", String.valueOf(e.getCause())));
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                    out.add(new SendResult(targets.get(i).deviceId, "cancelled", "", null));
                }
            }
            return out;
        } finally {
            pool.shutdown();
        }
    }
}
