const snmp = require('net-snmp');
const axios = require('axios');
const qs = require('qs');

/**
 * Hioso OLT Engine - Optimized for Fast Parallel Polling
 */
class HiosoOLT {
    constructor(host, community = 'public', port = 161) {
        this.host = host.replace(/^https?:\/\//, '').split('/')[0].split(':')[0];
        this.community = community;
        this.port = port;
        this.session = null;

        this.oid_profiles = {
            'HIOSO_C': { 
                'name': '1.3.6.1.4.1.25355.3.2.6.3.2.1.37',
                'status': '1.3.6.1.4.1.25355.3.2.6.3.2.1.39',
                'tx': '1.3.6.1.4.1.25355.3.2.6.14.2.1.4',
                'rx': '1.3.6.1.4.1.25355.3.2.6.14.2.1.8',
                'mac': '1.3.6.1.4.1.25355.3.2.6.3.2.1.11',
                'divider': 1
            },
            'HIOSO_B': { 
                'name': '1.3.6.1.4.1.3320.101.10.1.1.79',
                'status': '1.3.6.1.4.1.3320.101.10.1.1.26',
                'tx': '1.3.6.1.4.1.3320.101.10.5.1.5',
                'rx': '1.3.6.1.4.1.3320.101.10.5.1.6',
                'mac': '1.3.6.1.4.1.3320.101.10.1.1.3',
                'divider': 10
            },
            'HIOSO_GPON': { 
                'name': '1.3.6.1.4.1.25355.3.3.1.1.1.2',
                'status': '1.3.6.1.4.1.25355.3.3.1.1.1.11',
                'tx': '1.3.6.1.4.1.25355.3.3.1.1.4.1.2',
                'rx': '1.3.6.1.4.1.25355.3.3.1.1.4.1.1',
                'mac': '1.3.6.1.4.1.25355.3.3.1.1.1.5',
                'divider': 100
            },
            'ZTE': { 
                'name': '1.3.6.1.4.1.3902.1012.3.28.1.1.2',
                'sn': '1.3.6.1.4.1.3902.1012.3.28.1.1.5',
                'status': '1.3.6.1.4.1.3902.1012.3.28.2.1.4',
                'tx': '1.3.6.1.4.1.3902.1012.3.50.12.1.1.9',
                'rx': '1.3.6.1.4.1.3902.1012.3.50.12.1.1.10',
                'mac': '1.3.6.1.4.1.3902.1012.3.28.1.1.5',
                'divider': 'zte'
            },
            'HIOSO_HA73': {
                'name': '1.3.6.1.4.1.34592.1.3.100.12.1.1.2',
                'status': '1.3.6.1.4.1.34592.1.3.100.12.1.1.5',
                'tx': '1.3.6.1.4.1.34592.1.3.100.12.1.1.13',
                'rx': '1.3.6.1.4.1.34592.1.3.100.12.1.1.14',
                'mac': '1.3.6.1.4.1.34592.1.3.100.12.1.1.12',
                'divider': 10
            }
        };
    }

    async getOnuList(cachedProfileName = null) {
        this.session = snmp.createSession(this.host, this.community, { 
            port: this.port, 
            version: snmp.Version2c, 
            timeout: 10000, 
            retries: 3,
            maxRepetitions: 20
        });

        try {
            let activeProfile = this.oid_profiles[cachedProfileName] || null;
            
            if (!activeProfile) {
                console.log(`[OLT SYNC] Probing OLT Brand...`);
                for (const [pName, pMap] of Object.entries(this.oid_profiles)) {
                    try {
                        const isMatch = await new Promise(resolve => {
                            this.session.getNext([pMap.name], (err, vbs) => {
                                if (!err && vbs[0]) {
                                    const cleanVbOid = vbs[0].oid.replace(/^\./, '').replace(/^iso\./, '1.');
                                    const cleanPMapName = pMap.name.replace(/^\./, '').replace(/^iso\./, '1.');
                                    if (cleanVbOid.startsWith(cleanPMapName)) resolve(true);
                                    else resolve(false);
                                } else resolve(false);
                            });
                        });
                        if (isMatch) { activeProfile = { ...pMap, pName }; break; }
                    } catch (e) {}
                }
            }

            if (!activeProfile) throw new Error("Gagal mendeteksi profil OLT.");

            console.log(`[OLT SYNC] Starting FAST MULTI-WALK for profile: ${activeProfile.pName}`);
            
            const activeOIDs = {};
            ['name', 'status', 'tx', 'rx', 'mac', 'sn'].forEach(k => { 
                if (activeProfile[k]) activeOIDs[k] = activeProfile[k].replace(/^\./, '').replace(/^iso\./, '1.'); 
            });

            const extractIdx = (rawOid, baseOid) => {
                if (!rawOid || !baseOid) return '';
                const r = rawOid.replace(/^\./, '').replace(/^iso\./, '1.');
                const b = baseOid.replace(/^\./, '').replace(/^iso\./, '1.');
                if (r.startsWith(b)) return r.substring(b.length).replace(/^\./, '');
                const parts = r.split('.');
                return parts.slice(-2).join('.');
            };

            const parseSignal = (val) => {
                let num = parseFloat(val);
                if (isNaN(num) || num === 0 || num === 65535 || num === -65535) return "0.00";
                if (activeProfile.divider === 'zte') return ((num - 15000) / 500).toFixed(2);
                const div = activeProfile.divider || 1;
                if (Math.abs(num) > 500 && div === 1) return (num / 100).toFixed(2);
                return (num / div).toFixed(2);
            };

            const formatMac = (val) => {
                if (!val) return '';
                if (Buffer.isBuffer(val)) {
                    if (val.length === 6) return Array.from(val).map(b => b.toString(16).padStart(2, '0')).join(':').toUpperCase();
                    const s = val.toString().trim();
                    if (/^[0-9A-Fa-f]{12}$/.test(s)) return s.match(/.{2}/g).join(':').toUpperCase();
                    return s.toUpperCase();
                }
                return val.toString().trim().toUpperCase();
            };

            const categories = Object.keys(activeOIDs);
            const dataStore = {};
            categories.forEach(c => dataStore[c] = {});

            const runMultiWalk = async () => {
                let currentPointers = categories.map(c => activeOIDs[c]);
                let finished = new Array(categories.length).fill(false);

                while (finished.includes(false)) {
                    const toFetch = currentPointers.filter((_, i) => !finished[i]);
                    const fetchIndices = categories.map((_, i) => i).filter(i => !finished[i]);
                    if (toFetch.length === 0) break;

                    const vbs = await new Promise((resolve, reject) => {
                        this.session.getNext(toFetch, (err, vbs) => {
                            if (err) return reject(err);
                            resolve(vbs);
                        });
                    });

                    for (let i = 0; i < fetchIndices.length; i++) {
                        const catIdx = fetchIndices[i];
                        const vb = vbs[i];
                        if (!vb || !vb.oid || snmp.isVarbindError(vb)) { finished[catIdx] = true; continue; }
                        
                        const cleanOid = vb.oid.replace(/^\./, '').replace(/^iso\./, '1.');
                        const baseOid = activeOIDs[categories[catIdx]];
                        
                        if (cleanOid.startsWith(baseOid)) {
                            const idx = extractIdx(cleanOid, baseOid);
                            dataStore[categories[catIdx]][idx] = vb.value;
                            currentPointers[catIdx] = cleanOid;
                        } else {
                            finished[catIdx] = true;
                        }
                    }
                }
            };

            await runMultiWalk();

            const onus = [];
            const isGPON = activeProfile.pName === 'HIOSO_GPON' || activeProfile.name.includes('.25355.3.3');

            for (const [idx, rawName] of Object.entries(dataStore.name)) {
                const name = rawName.toString().replace(/[^\x20-\x7E]/g, '').trim();
                if (!name || ['public', 'internal', 'private'].some(s => name.toLowerCase().includes(s))) continue;

                let status = 'Down';
                const sVal = dataStore.status[idx];
                if (sVal !== undefined) {
                    const v = parseInt(sVal);
                    if (activeProfile.pName === 'ZTE') status = (v === 3) ? 'Up' : 'Down';
                    else if (isGPON) status = (v >= 2 && v <= 4) ? 'Up' : 'Down';
                    else status = (v === 1 || v === 3 || v === 4) ? 'Up' : 'Down';
                }

                onus.push({
                    index: idx, name, status,
                    tx_power: parseSignal(dataStore.tx[idx]),
                    rx_power: parseSignal(dataStore.rx[idx]),
                    sn: dataStore.sn ? (dataStore.sn[idx] || '').toString() : '',
                    mac: dataStore.mac ? formatMac(dataStore.mac[idx]) : ''
                });
            }
            return { onus, detectedProfile: activeProfile.pName };
        } finally {
            if (this.session) this.session.close();
        }
    }

    async getOnuData(index, cachedProfileName = null) {
        this.session = snmp.createSession(this.host, this.community, { 
            port: this.port, version: snmp.Version2c, timeout: 5000, retries: 1 
        });
        try {
            let pMap = this.oid_profiles[cachedProfileName || 'HIOSO_C'];
            const oids = [pMap.status + '.' + index, pMap.tx + '.' + index, pMap.rx + '.' + index];

            return new Promise((resolve, reject) => {
                this.session.get(oids, (error, varbinds) => {
                    if (error) return reject(error);
                    const data = { status: 'Down', tx_power: '0.00', rx_power: '0.00' };
                    const parseSignal = (val) => {
                        let num = parseFloat(val);
                        if (isNaN(num) || num === 0 || num === 65535 || num === -65535) return "0.00";
                        if (pMap.divider === 'zte') return ((num - 15000) / 500).toFixed(2);
                        return (num / (pMap.divider || 1)).toFixed(2);
                    };
                    if (varbinds[0] && !snmp.isVarbindError(varbinds[0])) {
                        const v = parseInt(varbinds[0].value);
                        if (cachedProfileName === 'ZTE') data.status = (v === 3) ? 'Up' : 'Down';
                        else data.status = (v === 1 || v === 3 || v === 4) ? 'Up' : 'Down';
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
                index, action: 'reboot', terminal_id: index
            }), { headers: { Cookie: cookie }, timeout: 10000 });
            return res.status === 200;
        } catch (e) {
            return false;
        }
    }

    async walk(oid) {
        this.session = snmp.createSession(this.host, this.community, { port: this.port, version: snmp.Version2c, timeout: 5000, retries: 1 });
        return new Promise((resolve, reject) => {
            this.session.get([oid], (error, varbinds) => {
                this.session.close();
                if (error) return reject(error);
                resolve(varbinds);
            });
        });
    }
}

module.exports = HiosoOLT;
