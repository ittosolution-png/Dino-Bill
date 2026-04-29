const snmp = require('net-snmp');
const axios = require('axios');
const qs = require('qs');

/**
 * Hioso OLT Engine - Ported from Gembok Simples HiosoSNMP Class
 */
class HiosoOLT {
    constructor(host, community = 'public', port = 161) {
        // Sanitize Host
        this.host = host.replace(/^https?:\/\//, '').split('/')[0].split(':')[0];
        this.community = community;
        this.port = port;
        this.session = null;

        // Profiles from hioso.php
        this.oid_profiles = {
            'HIOSO_C': { // C-Data based
                'name': '1.3.6.1.4.1.25355.3.2.6.3.2.1.37',
                'sn': '1.3.6.1.4.1.25355.3.2.6.3.2.1.11',
                'status': '1.3.6.1.4.1.25355.3.2.6.3.2.1.39',
                'tx': '1.3.6.1.4.1.25355.3.2.6.14.2.1.4',
                'rx': '1.3.6.1.4.1.25355.3.2.6.14.2.1.8',
                'divider': 1
            },
            'HIOSO_B': { // BDCOM based
                'name': '1.3.6.1.4.1.3320.101.10.1.1.79',
                'sn': '1.3.6.1.4.1.3320.101.10.1.1.3',
                'status': '1.3.6.1.4.1.3320.101.10.1.1.26',
                'tx': '1.3.6.1.4.1.3320.101.10.5.1.5',
                'rx': '1.3.6.1.4.1.3320.101.10.5.1.6',
                'divider': 10
            },
            'HIOSO_GPON': { // C-Data GPON
                'name': '1.3.6.1.4.1.25355.3.3.1.1.1.2',
                'sn': '1.3.6.1.4.1.25355.3.3.1.1.1.5',
                'status': '1.3.6.1.4.1.25355.3.3.1.1.1.11',
                'tx': '1.3.6.1.4.1.25355.3.3.1.1.4.1.2',
                'rx': '1.3.6.1.4.1.25355.3.3.1.1.4.1.1',
                'divider': 100
            }
        };
    }

    async walk(oid) {
        return new Promise((resolve, reject) => {
            const results = {};
            let count = 0;
            const timeoutId = setTimeout(() => {
                console.log(`[OLT DEBUG] Walk for ${oid} TIMED OUT after 4s. Returning partial data.`);
                resolve(results);
            }, 4000);

            const cleanOid = oid.replace(/^\./, '').replace(/^iso\./, '1.');
            this.session.walk(cleanOid, 20, (varbinds) => {
                for (const vb of varbinds) {
                    const cleanVbOid = vb.oid.replace(/^\./, '').replace(/^iso\./, '1.');
                    if (!snmp.isVarbindError(vb) && (cleanVbOid.startsWith(cleanOid) || cleanVbOid.startsWith('1.3.6.1.4.1.' + cleanOid))) {
                        results[cleanVbOid] = vb.value;
                        count++;
                    } else {
                        return false; 
                    }
                }
            }, (error) => {
                clearTimeout(timeoutId);
                if (error) {
                    console.log(`[OLT DEBUG] Walk for ${oid} error: ${error.message}`);
                    resolve(results); // Resolve with empty results instead of rejecting
                } else {
                    if (count > 0) {
                        console.log(`[OLT DEBUG] Walk for ${oid} finished. Found ${count} items.`);
                    }
                    resolve(results);
                }
            });
        });
    }

    async getOnuList(cachedProfileName = null) {
        this.session = snmp.createSession(this.host, this.community, { 
            port: this.port, version: snmp.Version2c, timeout: 5000, retries: 1 
        });

        // Add HA73 to main profiles
        this.oid_profiles['HIOSO_HA73'] = {
            'name': '1.3.6.1.4.1.34592.1.3.100.12.1.1.2',
            'sn': '1.3.6.1.4.1.34592.1.3.100.12.1.1.12',
            'status': '1.3.6.1.4.1.34592.1.3.100.12.1.1.5',
            'tx': '1.3.6.1.4.1.34592.1.3.100.12.1.1.13',
            'rx': '1.3.6.1.4.1.34592.1.3.100.12.1.1.14',
            'divider': 10
        };

        try {
            // 1. Detect Active Profile
            let activeProfile = null;
            let names = null;

            // TRY CACHED FIRST
            if (cachedProfileName && this.oid_profiles[cachedProfileName]) {
                const pMap = this.oid_profiles[cachedProfileName];
                console.log(`[OLT SYNC] Trying cached profile: ${cachedProfileName}...`);
                try {
                    names = await this.walk(pMap.name);
                    if (Object.keys(names).length > 0) {
                        activeProfile = { ...pMap, pName: cachedProfileName };
                    }
                } catch (e) {
                    console.log(`[OLT SYNC] Cached profile ${cachedProfileName} failed.`);
                }
            }

            if (!activeProfile) {
                console.log(`[OLT SYNC] Fast-Probing ${this.host} with ${Object.keys(this.oid_profiles).length} profiles...`);

                for (const [pName, pMap] of Object.entries(this.oid_profiles)) {
                    try {
                        const isMatch = await new Promise(resolve => {
                            this.session.getNext([pMap.name], (err, vbs) => {
                                if (!err && vbs[0] && vbs[0].oid.startsWith(pMap.name)) {
                                    const sample = vbs[0].value.toString();
                                    if (sample && !sample.includes('1.3.6.')) resolve(true);
                                    else resolve(false);
                                } else resolve(false);
                            });
                        });

                        if (isMatch) {
                            console.log(`[OLT SYNC] Profile ${pName} matched! Fetching full data...`);
                            activeProfile = { ...pMap, pName };
                            names = await this.walk(pMap.name);
                            break;
                        }
                    } catch (e) {
                        console.log(`[OLT SYNC] Fast-Probe ${pName} error: ${e.message}`);
                    }
                }
            }

            if (!activeProfile) {
                // Try fallback HA73 branch (Missing from user's hioso.php but common)
                const ha73_name = '1.3.6.1.4.1.34592.1.3.100.12.1.1.2';
                const res = await this.walk(ha73_name);
                if (Object.keys(res).length > 0) {
                    activeProfile = {
                        pName: 'HIOSO_HA73',
                        name: ha73_name,
                        sn: '1.3.6.1.4.1.34592.1.3.100.12.1.1.12',
                        status: '1.3.6.1.4.1.34592.1.3.100.12.1.1.5',
                        tx: '1.3.6.1.4.1.34592.1.3.100.12.1.1.13',
                        rx: '1.3.6.1.4.1.34592.1.3.100.12.1.1.14',
                        divider: 10
                    };
                    names = res;
                }
            }

            if (!activeProfile) throw new Error("Perangkat bukan Hioso/C-Data OLT atau SNMP salah.");

            const parentBranch = activeProfile.name.substring(0, activeProfile.name.lastIndexOf('.'));

            // 3. Parallel Walk Status & Signal (with Fallbacks)
            console.log(`[OLT SYNC] Fetching Status and Signals in parallel...`);
            const fetchFallback = async (label, mainOid, fallbackOids = []) => {
                console.log(`[OLT SYNC] Fetching ${label} (Main OID: ${mainOid})...`);
                let res = await this.walk(mainOid);
                if (Object.keys(res).length === 0) {
                    for (const foid of fallbackOids) {
                        console.log(`[OLT SYNC] ${label} fallback: ${foid}...`);
                        // Use a very short timeout for fallbacks
                        res = await this.walk(foid);
                        if (Object.keys(res).length > 0) break;
                    }
                }
                return res;
            };

            // Update profiles based on known working OIDs for this specific user
            if (activeProfile.pName === 'HIOSO_C') {
                // User's OLT seems to have issues with .39, let's add .2 as a strong fallback
                activeProfile.statusFallback = [parentBranch + '.2', parentBranch + '.5', parentBranch + '.39'];
            }

            const [statuses, txs, rxs] = await Promise.all([
                fetchFallback('Status', activeProfile.status, activeProfile.statusFallback || [parentBranch + '.2', parentBranch + '.5']),
                fetchFallback('TX', activeProfile.tx, [parentBranch + '.13', '.1.3.6.1.4.1.25355.3.2.6.1.1.1.1.9']),
                fetchFallback('RX', activeProfile.rx, [parentBranch + '.14', '.1.3.6.1.4.1.25355.3.2.6.1.1.1.1.10'])
            ]);
            
            if (Object.keys(names).length > 0) {
                console.log(`[OLT DEBUG] Sample Name OID: ${Object.keys(names)[0]}`);
                console.log(`[OLT DEBUG] Expected Status OID prefix: ${activeProfile.status}`);
            }
            
            console.log(`[OLT SYNC] Data fetch complete.`);
            console.log(`[OLT SYNC] Fetched ${Object.keys(statuses).length} statuses, ${Object.keys(txs).length} TX, ${Object.keys(rxs).length} RX.`);

            const isGPON = activeProfile.pName === 'HIOSO_GPON' || activeProfile.name.includes('.25355.3.3');
            const parsedOnus = {};

            const extractIdx = (rawOid, baseOid) => {
                const cleanRaw = rawOid.replace(/^\./, '').replace(/^iso\./, '1.');
                const cleanBase = baseOid.replace(/^\./, '').replace(/^iso\./, '1.');
                if (cleanRaw.startsWith(cleanBase)) {
                    return cleanRaw.substring(cleanBase.length).replace(/^\./, '');
                }
                // Fallback anchor
                const parts = cleanRaw.split('.');
                const baseParts = cleanBase.split('.');
                const lastAnchor = baseParts[baseParts.length - 1];
                const found = parts.lastIndexOf(lastAnchor);
                return found !== -1 ? parts.slice(found + 1).join('.') : cleanRaw;
            };

            const parseSignal = (val) => {
                let num = parseFloat(val);
                if (isNaN(num) || num === 0 || num === 65535 || num === -65535) return "0.00";
                const abs = Math.abs(num);
                const div = activeProfile.divider || 1;
                
                // If it's a large integer like -2540, auto-scale it
                if (abs > 500 && div === 1) return (num / 100).toFixed(2);
                return (num / div).toFixed(2);
            };

            console.log(`[OLT SYNC] Mapping ${Object.keys(names).length} ONU names...`);
            // Map Names
            for (const [oid, val] of Object.entries(names)) {
                const idx = extractIdx(oid, activeProfile.name);
                parsedOnus[idx] = { 
                    index: idx, 
                    name: val.toString().replace(/[^\x20-\x7E]/g, '').trim(), 
                    sn: '', status: 'Down', tx_power: '0.00', rx_power: '0.00' 
                };
            }

            console.log(`[OLT SYNC] Mapping Status and Signals...`);
            // Map Status
            for (const [oid, val] of Object.entries(statuses)) {
                const idx = extractIdx(oid, activeProfile.status);
                if (parsedOnus[idx]) {
                    const v = parseInt(val);
                    if (isGPON) parsedOnus[idx].status = (v >= 2 && v <= 4) ? 'Up' : 'Down';
                    else parsedOnus[idx].status = (v === 1 || v === 3 || v === 4) ? 'Up' : 'Down';
                }
            }

            // Map Signals
            for (const [oid, val] of Object.entries(txs)) {
                const idx = extractIdx(oid, activeProfile.tx);
                if (parsedOnus[idx]) parsedOnus[idx].tx_power = parseSignal(val);
            }
            for (const [oid, val] of Object.entries(rxs)) {
                const idx = extractIdx(oid, activeProfile.rx);
                if (parsedOnus[idx]) parsedOnus[idx].rx_power = parseSignal(val);
            }

            const resultCount = Object.keys(parsedOnus).length;
            console.log(`[OLT SYNC] Final filter... items before: ${resultCount}`);

            // Final Filtering with extreme strictness
            const filteredOnus = Object.values(parsedOnus).filter(o => {
                const rx = parseFloat(o.rx_power);
                const tx = parseFloat(o.tx_power);
                
                const isGeneric = ['public', 'internal', 'private', 'all', 'grpcomm'].some(s => o.name.toLowerCase().includes(s));
                if (isGeneric) return false;

                if (o.index.length > 20 || o.index.split('.').length > 5) return false;
                if (rx === 0 && tx === 0 && !o.sn && !o.name) return false;
                if (o.name.toUpperCase().includes('NO SUCH')) return false;

                return true;
            });

            return { onus: filteredOnus, detectedProfile: activeProfile.pName };
        } catch (error) {
            console.error(`[OLT HELPER ERROR] ${error.message}`);
            throw error;
        } finally {
            if (this.session) this.session.close();
        }
    }

    async rebootOnu(index, user, pass) {
        const baseUrl = `http://${this.host}`;
        try {
            const login = await axios.post(`${baseUrl}/goform/login`, qs.stringify({
                user, pass, username: user, password: pass, submit: 'Login'
            }), { timeout: 5000, validateStatus: false });
            const cookie = login.headers['set-cookie']?.[0] || '';
            const res = await axios.post(`${baseUrl}/goform/setOnu`, qs.stringify({
                onuId: this.resolveWebId(index), onuName: 'Reboot', onuOperation: 'rebootOp'
            }), { headers: { 'Cookie': cookie }, timeout: 5000, validateStatus: false });
            return res.status < 400;
        } catch (e) { return false; }
    }

    resolveWebId(index) {
        const parts = index.split('.');
        if (parts.length >= 2) {
            return `0/1/${parts[parts.length-2]}:${parts[parts.length-1]}`;
        }
        return `0/1/1:${index}`;
    }
}

module.exports = HiosoOLT;
