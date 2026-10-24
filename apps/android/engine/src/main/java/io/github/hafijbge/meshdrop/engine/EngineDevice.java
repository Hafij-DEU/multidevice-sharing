package io.github.hafijbge.meshdrop.engine;

/** A device as the app shows it: paired (trusted) or nearby, and whether it is on the LAN now. */
public final class EngineDevice {
    public final String deviceId;
    public final String alias;
    /** paired | nearby (mesh roles arrive with M4b). */
    public final String role;
    public final boolean trusted;
    /** lan | offline */
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
