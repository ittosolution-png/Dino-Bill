/**
 * MikroTik RouterOS API Helper
 * Wraps routeros-api for PPPoE, Hotspot, and system operations
 */
const RouterOSAPI = require('routeros-api').RouterOSAPI;

/**
 * Connect to a MikroTik router
 * @param {Object} router - { ip_address, username, password, port }
 * @returns {RouterOSAPI} connected API instance
 */
async function connect(router) {
    const api = new RouterOSAPI({
        host: router.ip_address,
        user: router.username,
        password: router.password,
        port: router.port || 8728,
        timeout: 5
    });
    await api.connect();
    return api;
}

/**
 * Safely execute a MikroTik API operation
 */
async function safeExecute(router, operation) {
    let api;
    try {
        api = await connect(router);
        const result = await operation(api);
        await api.close();
        return { success: true, data: result };
    } catch (e) {
        if (api) try { await api.close(); } catch (_) {}
        console.error(`[MikroTik] Error on ${router.ip_address}:`, e.message);
        return { success: false, message: e.message };
    }
}

// ============ PPPoE Operations ============

/**
 * Get all PPPoE secrets from router
 */
async function getPPPoESecrets(router) {
    return safeExecute(router, async (api) => {
        const data = await api.write('/ppp/secret/print');
        return data.map(d => ({
            name: d.name,
            password: d.password,
            profile: d.profile || 'default',
            service: d.service || 'pppoe',
            disabled: d.disabled === 'true'
        }));
    });
}

/**
 * Add a PPPoE secret
 */
async function addPPPoESecret(router, username, password, profile = 'default') {
    return safeExecute(router, async (api) => {
        return api.write('/ppp/secret/add', [
            '=name=' + username,
            '=password=' + password,
            '=profile=' + profile,
            '=service=pppoe'
        ]);
    });
}

/**
 * Remove a PPPoE secret
 */
async function removePPPoESecret(router, username) {
    return safeExecute(router, async (api) => {
        const secrets = await api.write('/ppp/secret/print', ['?name=' + username]);
        if (secrets.length > 0) {
            return api.write('/ppp/secret/remove', ['=.id=' + secrets[0]['.id']]);
        }
        return null;
    });
}

/**
 * Disable a PPPoE secret (isolate customer)
 */
async function disablePPPoESecret(router, username) {
    return safeExecute(router, async (api) => {
        const secrets = await api.write('/ppp/secret/print', ['?name=' + username]);
        if (secrets.length > 0) {
            await api.write('/ppp/secret/set', [
                '=.id=' + secrets[0]['.id'],
                '=disabled=yes'
            ]);
            // Also disconnect active session
            const active = await api.write('/ppp/active/print', ['?name=' + username]);
            if (active.length > 0) {
                await api.write('/ppp/active/remove', ['=.id=' + active[0]['.id']]);
            }
        }
        return true;
    });
}

/**
 * Enable a PPPoE secret (unisolate customer)
 */
async function enablePPPoESecret(router, username) {
    return safeExecute(router, async (api) => {
        const secrets = await api.write('/ppp/secret/print', ['?name=' + username]);
        if (secrets.length > 0) {
            return api.write('/ppp/secret/set', [
                '=.id=' + secrets[0]['.id'],
                '=disabled=no'
            ]);
        }
        return null;
    });
}

/**
 * Get active PPPoE connections
 */
async function getActiveConnections(router) {
    return safeExecute(router, async (api) => {
        const data = await api.write('/ppp/active/print');
        return data.map(d => ({
            name: d.name,
            address: d.address || '',
            uptime: d.uptime || '0s',
            callerid: d['caller-id'] || ''
        }));
    });
}

/**
 * Get PPP profiles
 */
async function getPPPProfiles(router) {
    return safeExecute(router, async (api) => {
        const data = await api.write('/ppp/profile/print');
        return data.map(d => ({
            name: d.name || '',
            localAddress: d['local-address'] || '',
            remoteAddress: d['remote-address'] || '',
            rateLimit: d['rate-limit'] || ''
        }));
    });
}

// ============ Hotspot Operations ============

/**
 * Get all hotspot users
 */
async function getHotspotUsers(router) {
    return safeExecute(router, async (api) => {
        const data = await api.write('/ip/hotspot/user/print');
        return data.map(d => ({
            id: d['.id'],
            name: d.name || '',
            password: d.password || '',
            profile: d.profile || 'default',
            uptime: d.uptime || '0s',
            address: d.address || '',
            disabled: d.disabled === 'true',
            comment: d.comment || ''
        }));
    });
}

/**
 * Add a hotspot user
 */
async function addHotspotUser(router, name, password, profile = 'default') {
    return safeExecute(router, async (api) => {
        return api.write('/ip/hotspot/user/add', [
            '=name=' + name,
            '=password=' + password,
            '=profile=' + profile
        ]);
    });
}

/**
 * Remove a hotspot user
 */
async function removeHotspotUser(router, name) {
    return safeExecute(router, async (api) => {
        const users = await api.write('/ip/hotspot/user/print', ['?name=' + name]);
        if (users.length > 0) {
            return api.write('/ip/hotspot/user/remove', ['=.id=' + users[0]['.id']]);
        }
        return null;
    });
}

/**
 * Get hotspot profiles
 */
async function getHotspotProfiles(router) {
    return safeExecute(router, async (api) => {
        const data = await api.write('/ip/hotspot/user/profile/print');
        return data.map(d => ({
            name: d.name || '',
            rateLimit: d['rate-limit'] || '',
            sharedUsers: d['shared-users'] || '1'
        }));
    });
}

/**
 * Add a hotspot profile
 */
async function addHotspotProfile(router, name, rateLimit, sharedUsers = 1) {
    return safeExecute(router, async (api) => {
        const params = [
            '=name=' + name,
            '=shared-users=' + sharedUsers
        ];
        if (rateLimit) params.push('=rate-limit=' + rateLimit);
        return api.write('/ip/hotspot/user/profile/add', params);
    });
}

/**
 * Get active hotspot sessions
 */
async function getHotspotActive(router) {
    return safeExecute(router, async (api) => {
        const data = await api.write('/ip/hotspot/active/print');
        return data.map(d => ({
            user: d.user || '',
            address: d.address || '',
            uptime: d.uptime || '0s',
            macAddress: d['mac-address'] || ''
        }));
    });
}

// ============ System Operations ============

/**
 * Get system resource (CPU, memory, uptime, version)
 */
async function getSystemResource(router) {
    return safeExecute(router, async (api) => {
        const data = await api.write('/system/resource/print');
        if (data.length > 0) {
            const r = data[0];
            return {
                uptime: r.uptime || '0s',
                version: r.version || 'unknown',
                cpuLoad: r['cpu-load'] || '0',
                freeMemory: r['free-memory'] || '0',
                totalMemory: r['total-memory'] || '0',
                boardName: r['board-name'] || 'MikroTik',
                platform: r.platform || ''
            };
        }
        return null;
    });
}

/**
 * Get real-time traffic from an interface
 */
async function getInterfaceTraffic(router, interfaceName = 'ether1') {
    return safeExecute(router, async (api) => {
        const data = await api.write('/interface/monitor-traffic', [
            '=interface=' + interfaceName,
            '=once='
        ]);
        if (data.length > 0) {
            const d = data[0];
            return {
                rx: d['rx-bits-per-second'] || '0',
                tx: d['tx-bits-per-second'] || '0'
            };
        }
        return { rx: '0', tx: '0' };
    });
}

/**
 * Check if router is reachable
 */
async function checkStatus(router) {
    try {
        const api = new RouterOSAPI({
            host: router.ip_address,
            user: router.username,
            password: router.password,
            port: router.port || 8728,
            timeout: 3
        });
        await api.connect();
        const res = await api.write('/system/identity/print');
        await api.close();
        return { success: true, identity: (res[0] && res[0].name) ? res[0].name : 'MikroTik' };
    } catch (e) {
        return { success: false, message: e.message };
    }
}

module.exports = {
    connect,
    safeExecute,
    getPPPoESecrets,
    addPPPoESecret,
    removePPPoESecret,
    disablePPPoESecret,
    enablePPPoESecret,
    getActiveConnections,
    getPPPProfiles,
    getHotspotUsers,
    addHotspotUser,
    removeHotspotUser,
    getHotspotProfiles,
    addHotspotProfile,
    getHotspotActive,
    getSystemResource,
    getInterfaceTraffic,
    checkStatus
};
