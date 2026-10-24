package io.github.hafijbge.meshdrop.engine;

/** A device as the app shows it: paired (trusted) or nearby, and whether it is on the LAN now. */
public final class EngineDevice {
    public final String deviceId;
    public final String alias;
    /** hub | member (mesh devices), paired (manually) | nearby (untrusted). */
    public final String role;
    public final boolean trusted;
    /** lan | hub (reachable through the hub) | offline */
    public final String reach;
    public final String deviceType;
    public final long lastSeen;

    public EngineDevice(String deviceId, String alias, String role, boolean trusted, String reach, String deviceType, long lastSeen) {
        this.deviceId = deviceId;
        this.alias = alias;
        this.role = role;
        this.trusted = trusted;
        this.reach = reach;
        this.deviceType = deviceType;
        this.lastSeen = lastSeen;
    }
}
