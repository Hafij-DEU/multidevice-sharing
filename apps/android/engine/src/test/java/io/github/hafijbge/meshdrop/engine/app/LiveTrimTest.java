package io.github.hafijbge.meshdrop.engine.app;

import static org.junit.Assert.assertEquals;

import org.junit.Test;

public class LiveTrimTest {
    static int ms(int n) {
        return 48 * n; // frames at 48 kHz
    }

    @Test
    public void onWiFiKeepsAtMost120msQueued() {
        LiveTrim t = LiveTrim.lan();
        assertEquals(ms(120), t.keep(ms(200), 0));
        assertEquals(ms(20), t.keep(ms(200), ms(100)));
        assertEquals(0, t.keep(ms(20), ms(130)));
    }

    @Test
    public void overBluetoothABurstThatFitsIsPlayedWhole() {
        // RFCOMM delivers in bursts: a 300 ms burst onto 100 ms queued is jitter, not a backlog
        LiveTrim t = LiveTrim.bluetooth();
        assertEquals(ms(300), t.keep(ms(300), ms(100)));
        assertEquals(ms(40), t.keep(ms(40), ms(400)));
        assertEquals(0, t.dropped());
    }

    @Test
    public void overBluetoothABacklogIsCutBackToTheTarget() {
        LiveTrim t = LiveTrim.bluetooth();
        // 300 ms queued + 400 ms arriving passes the 500 ms ceiling: keep only up to 200 ms queued
        assertEquals(0, t.keep(ms(400), ms(300)));
        assertEquals(ms(150), t.keep(ms(2000), ms(50)));
        assertEquals(ms(400) + ms(1850), t.dropped());
    }
}
