package io.github.hafijbge.meshdrop.engine.send;

/** How a send to one device ended: done, failed (with an error string), or cancelled (paused). */
public final class SendResult {
    public final String deviceId;
    public final String status;
    public final String sessionId;
    public final String error;

    public SendResult(String deviceId, String status, String sessionId, String error) {
        this.deviceId = deviceId;
        this.status = status;
        this.sessionId = sessionId;
        this.error = error;
    }

    @Override
    public String toString() {
        return deviceId.substring(0, Math.min(8, deviceId.length())) + " " + status + (error != null ? " " + error : "");
    }
}
