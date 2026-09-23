/**
 * didahSDR - shared reconnect timer for the replay and Kiwi WebSockets.
 * The caller decides whether a reconnect is still wanted.
 */

function clearReconnectTimer(owner) {
    if (!owner.reconnectTimer) return;
    clearTimeout(owner.reconnectTimer);
    owner.reconnectTimer = null;
}

function armReconnect(owner, ms, fn) {
    if (owner.reconnectTimer) return false;
    owner.reconnectTimer = setTimeout(() => {
        owner.reconnectTimer = null;
        fn();
    }, ms);
    return true;
}

if (typeof globalThis !== 'undefined') {
    globalThis.clearReconnectTimer = clearReconnectTimer;
    globalThis.armReconnect = armReconnect;
}
if (typeof module !== 'undefined') module.exports = { clearReconnectTimer, armReconnect };
