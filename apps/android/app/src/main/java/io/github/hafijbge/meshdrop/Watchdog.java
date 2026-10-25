package io.github.hafijbge.meshdrop;

import android.app.job.JobInfo;
import android.app.job.JobParameters;
import android.app.job.JobScheduler;
import android.app.job.JobService;
import android.content.ComponentName;
import android.content.Context;

/**
 * Brings MeshService back if the system stopped it and did not restart it (some ROMs, Xiaomi/HyperOS
 * above all, skip START_STICKY). A periodic job (every 15 min, kept across reboots) starts the service
 * again; starting a foreground service from the background is allowed because MeshDrop is exempt
 * from battery optimization (Keep MeshDrop alive, or apps/android/scripts/keep-alive-adb.sh).
 */
public final class Watchdog extends JobService {
    private static final int JOB_ID = 4711;

    static void schedule(Context ctx) {
        JobScheduler js = ctx.getSystemService(JobScheduler.class);
        if (js == null || js.getPendingJob(JOB_ID) != null) return;
        js.schedule(new JobInfo.Builder(JOB_ID, new ComponentName(ctx, Watchdog.class))
                .setPeriodic(15 * 60_000L)
                .setPersisted(true)
                .build());
    }

    @Override
    public boolean onStartJob(JobParameters params) {
        if (!MeshService.running()) {
            try {
                MeshService.start(this);
            } catch (RuntimeException ignored) {
                // not allowed right now (no battery exemption): the next run tries again
            }
        }
        return false;
    }

    @Override
    public boolean onStopJob(JobParameters params) {
        return true;
    }
}
