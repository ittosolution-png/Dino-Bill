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

        // Profiles from hioso.php and ZTE reference
        this.oid_profiles = {
            'HIOSO_C': { // C-Data based
                'name': '1.3.6.1.4.1.25355.3.2.6.3.2.1.37',
                'status': '1.3.6.1.4.1.25355.3.2.6.3.2.1.39',
                'tx': '1.3.6.1.4.1.25355.3.2.6.14.2.1.4',
                'rx': '1.3.6.1.4.1.25355.3.2.6.14.2.1.8',
                'divider': 1
            },
            'HIOSO_B': { // BDCOM based
                'name': '1.3.6.1.4.1.3320.101.10.1.1.79',
                'status': '1.3.6.1.4.1.3320.101.10.1.1.26',
                'tx': '1.3.6.1.4.1.3320.101.10.5.1.5',
                'rx': '1.3.6.1.4.1.3320.101.10.5.1.6',
                'divider': 10
            },
            'HIOSO_GPON': { // C-Data GPON
                'name': '1.3.6.1.4.1.25355.3.3.1.1.1.2',
                'status': '1.3.6.1.4.1.25355.3.3.1.1.1.11',
                'tx': '1.3.6.1.4.1.25355.3.3.1.1.4.1.2',
                'rx': '1.3.6.1.4.1.25355.3.3.1.1.4.1.1',
                'divider': 100
            },
            'ZTE': { // ZTE C320/C300
                'name': '1.3.6.1.4.1.3902.1012.3.28.1.1.2',
                'sn': '1.3.6.1.4.1.3902.1012.3.28.1.1.5',
                'status': '1.3.6.1.4.1.3902.1012.3.28.2.1.4',
                'tx': '1.3.6.1.4.1.3902.1012.3.50.12.1.1.9',
                'rx': '1.3.6.1.4.1.3902.1012.3.50.12.1.1.10',
                'divider': 'zte'
            }
        };
    }

    async walk(oid) {
        return new Promise((resolve, reject) => {
            const results = {};
            let count = 0;
            const timeoutId = setTimeout(() => {
                console.log(`[OLT DEBUG] Walk for ${oid} TIMED OUT after 15s. Returning partial data.`);
                resolve(results);
            }, 15000);

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
                console.log(`[OLT SYNC] All standard profiles failed. Attempting Brute-Force Probe...`);
                // Common Hioso/C-Data/ZTE Branches
                const commonBranches = [
                    '1.3.6.1.4.1.34592.1.3.100.12.1.1.2', // HA73 standard
                    '1.3.6.1.4.1.25355.3.2.6.3.2.1.37',  // C-Data standard
                    '1.3.6.1.4.1.25355.3.3.1.1.1.2',     // C-Data GPON
                    '1.3.6.1.4.1.3320.101.10.1.1.79',    // BDCOM standard
                    '1.3.6.1.4.1.3902.1012.3.28.1.1.2'   // ZTE standard
                ];

                for (const branch of commonBranches) {
                    const res = await this.walk(branch);
                    if (Object.keys(res).length > 0) {
                        console.log(`[OLT SYNC] Found data on branch ${branch}. Using as fallback.`);
                        // Map back to a profile or create ad-hoc
                        if (branch.includes('34592')) {
                            activeProfile = { pName: 'HIOSO_HA73', name: branch, status: branch.replace('.2', '.5'), tx: branch.replace('.2', '.13'), rx: branch.replace('.2', '.14'), divider: 10 };
                        } else if (branch.includes('25355.3.2')) {
                            activeProfile = { pName: 'HIOSO_C', name: branch, status: branch.replace('.37', '.39'), tx: '1.3.6.1.4.1.25355.3.2.6.14.2.1.4', rx: '1.3.6.1.4.1.25355.3.2.6.14.2.1.8', divider: 1 };
                        } else if (branch.includes('25355.3.3')) {
                            activeProfile = { pName: 'HIOSO_GPON', name: branch, status: branch.replace('.2', '.11'), tx: '1.3.6.1.4.1.25355.3.3.1.1.4.1.2', rx: '1.3.6.1.4.1.25355.3.3.1.1.4.1.1', divider: 100 };
                        } else if (branch.includes('3902.1012')) {
                            activeProfile = { pName: 'ZTE', name: branch, sn: '1.3.6.1.4.1.3902.1012.3.28.1.1.5', status: '1.3.6.1.4.1.3902.1012.3.28.2.1.4', tx: '1.3.6.1.4.1.3902.1012.3.50.12.1.1.9', rx: '1.3.6.1.4.1.3902.1012.3.50.12.1.1.10', divider: 'zte' };
                        } else {
                            activeProfile = { pName: 'HIOSO_B', name: branch, status: branch.replace('.79', '.26'), tx: branch.replace('.79', '.5'), rx: branch.replace('.79', '.6'), divider: 10 };
                        }
                        names = res;
                        break;
                    }
                }
            }

            if (!activeProfile) {
                throw new Error("SNMP Response OK, tapi OID tidak ditemukan. Pastikan OLT anda adalah Hioso/C-Data dan SNMP Community 'public' memiliki izin READ.");
            }

            const parentBranch = activeProfile.name.substring(0, activeProfile.name.lastIndexOf('.'));

            // 3. Parallel Walk Status & Signal (with Fallbacks)
            const fetchFallback = async (label, mainOid, fallbackOids = []) => {
                console.log(`[OLT SYNC] Fetching ${label} (Main OID: ${mainOid})...`);
                let res = await this.walk(mainOid);
                if (Object.keys(res).length === 0) {
                    for (const foid of fallbackOids) {
                        console.log(`[OLT SYNC] ${label} fallback: ${foid}...`);
                        res = await this.walk(foid);
                        if (Object.keys(res).length > 0) break;
                    }
                }
                return res;
            };

            // Update profiles based on known working OIDs for this specific user
            if (activeProfile.pName === 'HIOSO_C') {
                activeProfile.statusFallback = [parentBranch + '.2', parentBranch + '.5', parentBranch + '.39'];
            }

            // 3. Sequential Walk Status & Signal (To avoid 'Socket forcibly closed')
            console.log(`[OLT SYNC] Fetching Status and Signals sequentially...`);
            const statuses = await fetchFallback('Status', activeProfile.status, activeProfile.statusFallback || [parentBranch + '.2', parentBranch + '.5']);
            await new Promise(r => setTimeout(r, 500)); // Brief pause
            const txs = await fetchFallback('TX', activeProfile.tx, [parentBranch + '.13', '.1.3.6.1.4.1.25355.3.2.6.1.1.1.1.9']);
            await new Promise(r => setTimeout(r, 500)); // Brief pause
            const rxs = await fetchFallback('RX', activeProfile.rx, [parentBranch + '.14', '.1.3.6.1.4.1.25355.3.2.6.1.1.1.1.10']);
            
            // 4. Fetch SN if available
            let sns = {};
            if (activeProfile.sn) {
                await new Promise(r => setTimeout(r, 500));
                sns = await this.walk(activeProfile.sn);
            }

            if (Object.keys(names).length > 0) {
                console.log(`[OLT DEBUG] Sample Name OID: ${Object.keys(names)[0]}`);
                console.log(`[OLT DEBUG] Expected Status OID prefix: ${activeProfile.status}`);
            }
            
            console.log(`[OLT SYNC] Data fetch complete.`);
            console.log(`[OLT SYNC] Fetched ${Object.keys(statuses).length} statuses, ${Object.keys(txs).length} TX, ${Object.keys(rxs).length} RX, ${Object.keys(sns).length} SN.`);

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
                
                if (activeProfile.divider === 'zte') {
                    // ZTE Formula: (Raw - 15000) / 500
                    return ((num - 15000) / 500).toFixed(2);
                }

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
                    if (activeProfile.pName === 'ZTE') {
                        parsedOnus[idx].status = (v === 3) ? 'Up' : 'Down';
                    } else if (isGPON) {
                        parsedOnus[idx].status = (v >= 2 && v <= 4) ? 'Up' : 'Down';
                    } else {
                        parsedOnus[idx].status = (v === 1 || v === 3 || v === 4) ? 'Up' : 'Down';
                    }
                }
            }

            // Map SN
            for (const [oid, val] of Object.entries(sns)) {
                const idx = extractIdx(oid, activeProfile.sn);
                if (parsedOnus[idx]) {
                    parsedOnus[idx].sn = val.toString().replace(/[^\x20-\x7E]/g, '').trim();
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
        } finally {
            if (this.session) this.session.close();
        }
    }

    async getOnuData(index, cachedProfileName = null) {
        this.session = snmp.createSession(this.host, this.community, { 
            port: this.port, version: snmp.Version2c, timeout: 5000, retries: 1 
        });

        // Add HA73 profile if not present
        if (!this.oid_profiles['HIOSO_HA73']) {
            this.oid_profiles['HIOSO_HA73'] = {
                'name': '1.3.6.1.4.1.34592.1.3.100.12.1.1.2',
                'status': '1.3.6.1.4.1.34592.1.3.100.12.1.1.5',
                'tx': '1.3.6.1.4.1.34592.1.3.100.12.1.1.13',
                'rx': '1.3.6.1.4.1.34592.1.3.100.12.1.1.14',
                'divider': 10
            };
        }

        try {
            // Identify profile
            let pMap = this.oid_profiles[cachedProfileName || 'HIOSO_C'];
            
            // OIDs for specific ONU
            const oids = [
                pMap.status + '.' + index,
                pMap.tx + '.' + index,
                pMap.rx + '.' + index
            ];

            return new Promise((resolve, reject) => {
                this.session.get(oids, (error, varbinds) => {
                    if (error) return reject(error);
                    
                    const data = { status: 'Down', tx_power: '0.00', rx_power: '0.00' };
                    const parseSignal = (val) => {
                        let num = parseFloat(val);
                        if (isNaN(num) || num === 0 || num === 65535 || num === -65535) return "0.00";
                        if (pMap.divider === 'zte') {
                            return ((num - 15000) / 500).toFixed(2);
                        }
                        const div = pMap.divider || 1;
                        return (num / div).toFixed(2);
                    };

                    if (varbinds[0] && !snmp.isVarbindError(varbinds[0])) {
                        const v = parseInt(varbinds[0].value);
                        if (cachedProfileName === 'ZTE') {
                            data.status = (v === 3) ? 'Up' : 'Down';
                        } else {
                            const isGPON = cachedProfileName === 'HIOSO_GPON';
                            if (isGPON) data.status = (v >= 2 && v <= 4) ? 'Up' : 'Down';
                            else data.status = (v === 1 || v === 3 || v === 4) ? 'Up' : 'Down';
                        }
                    }
                    if (varbinds[1] && !snmp.isVarbindError(varbinds[1])) data.tx_power = parseSignal(varbinds[1].value);
                    if (varbinds[2] && !snmp.isVarbindError(varbinds[2])) data.rx_power = parseSignal(varbinds[2].value);

                    resolve(data);
                });
            });
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
            const cookie = (login.headers['set-cookie'] && login.headers['set-cookie'][0]) ? login.headers['set-cookie'][0] : '';
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
