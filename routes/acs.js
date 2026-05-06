const express = require('express');
const router = express.Router();
const axios = require('axios');
let pool;

router.setPool = (dbPool) => { pool = dbPool; };

// Helper to get ACS settings
async function getACSSettings() {
    const [rows] = await pool.query("SELECT * FROM settings WHERE setting_key IN ('acs_url', 'acs_user', 'acs_pass', 'acs_vparams', 'acs_path_pppoe', 'acs_path_ip')");
    const s = {};
    rows.forEach(r => s[r.setting_key] = r.setting_value);
    return s;
}

function getAxiosConfig(s) {
    return {
        timeout: 5000,
        auth: s.acs_user ? { username: s.acs_user, password: s.acs_pass } : undefined
    };
}

// GET /acs
router.get('/', async (req, res) => {
    try {
        const s = await getACSSettings();
        
        let devices = [];
        let acsOnline = false;
        const vParams = s.acs_vparams ? s.acs_vparams.split(/\r?\n/).filter(p => p.trim()) : [];
        
        if (s.acs_url) {
            try {
                // Combine default projection with virtual parameters and common paths
                let projection = '_id,_lastInform,_deviceId._Manufacturer,_deviceId._ProductClass,_deviceId._SerialNumber';
                const commonPaths = [
                    s.acs_path_pppoe || 'VirtualParameters.PPPoEUser',
                    s.acs_path_ip || 'VirtualParameters.IPAddress',
                    'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANIPConnection.1.Username',
                    'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANIPConnection.1.ExternalIPAddress'
                ];
                
                projection += ',' + [...new Set(commonPaths)].join(',');
                if (vParams.length > 0) {
                    projection += ',' + vParams.join(',');
                }

                const response = await axios.get(`${s.acs_url}/devices`, {
                    ...getAxiosConfig(s),
                    params: { projection }
                });
                acsOnline = true;
                if (Array.isArray(response.data)) {
                    devices = response.data.map(d => {
                        // Helper to get value from nested path
                        const getVal = (path) => {
                            if (!path) return null;
                            const parts = path.split('.');
                            let val = d;
                            for (const part of parts) { 
                                val = (val && val[part]) ? val[part] : undefined; 
                            }
                            return (val && typeof val === 'object' && '_value' in val) ? val._value : val;
                        };

                        const device = {
                            id: d._id,
                            sn: (d._deviceId && d._deviceId._SerialNumber) ? d._deviceId._SerialNumber : d._id,
                            manufacturer: (d._deviceId && d._deviceId._Manufacturer) ? d._deviceId._Manufacturer : 'Unknown',
                            product_class: (d._deviceId && d._deviceId._ProductClass) ? d._deviceId._ProductClass : 'ONT',
                            last_inform: d._lastInform || null,
                            isOnline: d._lastInform ? (Date.now() - new Date(d._lastInform).getTime() < 300000) : false,
                            pppoe_user: getVal(s.acs_path_pppoe) || getVal('VirtualParameters.PPPoEUser') || getVal('InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANIPConnection.1.Username') || '-',
                            ip_address: getVal(s.acs_path_ip) || getVal('VirtualParameters.IPAddress') || getVal('InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANIPConnection.1.ExternalIPAddress') || '-',
                            vparams: {}
                        };
                        
                        // Extract additional virtual parameters
                        vParams.forEach(p => {
                            device.vparams[p] = getVal(p);
                        });
                        
                        return device;
                    });
                }
            } catch (err) {
                console.error("ACS API unreachable:", err.message);
            }
        }
        
        res.render('acs', { user: req.session, devices, acsOnline, acsUrl: s.acs_url || '', vParams, currentPage: 'acs' });
    } catch (err) {
        console.error(err);
        res.render('acs', { user: req.session, devices: [], acsOnline: false, acsUrl: '', currentPage: 'acs' });
    }
});

// POST /acs/api/reboot/:deviceId — Reboot device
router.post('/api/reboot/:deviceId', async (req, res) => {
    try {
        const s = await getACSSettings();
        if (!s.acs_url) return res.json({ success: false, message: 'ACS URL belum dikonfigurasi' });

        const deviceId = decodeURIComponent(req.params.deviceId);
        await axios.post(
            `${s.acs_url}/devices/${encodeURIComponent(deviceId)}/tasks`,
            { name: 'reboot' },
            { ...getAxiosConfig(s), params: { connection_request: '' } }
        );
        res.json({ success: true, message: `Perintah reboot dikirim ke ${deviceId}` });
    } catch (e) {
        const errorData = (e.response && e.response.data) ? e.response.data : e.message;
        res.json({ success: false, message: `Gagal: ${errorData}` });
    }
});

// POST /acs/api/refresh/:deviceId — Refresh device parameters
router.post('/api/refresh/:deviceId', async (req, res) => {
    try {
        const s = await getACSSettings();
        if (!s.acs_url) return res.json({ success: false, message: 'ACS URL belum dikonfigurasi' });

        const deviceId = decodeURIComponent(req.params.deviceId);
        await axios.post(
            `${s.acs_url}/devices/${encodeURIComponent(deviceId)}/tasks`,
            { name: 'refreshObject', objectName: '' },
            { ...getAxiosConfig(s), params: { connection_request: '' } }
        );
        res.json({ success: true, message: `Refresh parameter dikirim ke ${deviceId}` });
    } catch (e) {
        const errorData = (e.response && e.response.data) ? e.response.data : e.message;
        res.json({ success: false, message: `Gagal: ${errorData}` });
    }
});

// POST /acs/api/factory-reset/:deviceId — Factory reset device
router.post('/api/factory-reset/:deviceId', async (req, res) => {
    try {
        const s = await getACSSettings();
        if (!s.acs_url) return res.json({ success: false, message: 'ACS URL belum dikonfigurasi' });

        const deviceId = decodeURIComponent(req.params.deviceId);
        await axios.post(
            `${s.acs_url}/devices/${encodeURIComponent(deviceId)}/tasks`,
            { name: 'factoryReset' },
            { ...getAxiosConfig(s), params: { connection_request: '' } }
        );
        res.json({ success: true, message: `Factory reset dikirim ke ${deviceId}` });
    } catch (e) {
        const errorData = (e.response && e.response.data) ? e.response.data : e.message;
        res.json({ success: false, message: `Gagal: ${errorData}` });
    }
});

// DELETE /acs/api/device/:deviceId — Delete device from ACS
router.delete('/api/device/:deviceId', async (req, res) => {
    try {
        const s = await getACSSettings();
        if (!s.acs_url) return res.json({ success: false, message: 'ACS URL belum dikonfigurasi' });

        const deviceId = decodeURIComponent(req.params.deviceId);
        await axios.delete(
            `${s.acs_url}/devices/${encodeURIComponent(deviceId)}`,
            getAxiosConfig(s)
        );
        res.json({ success: true, message: `Device ${deviceId} dihapus dari ACS` });
    } catch (e) {
        const errorData = (e.response && e.response.data) ? e.response.data : e.message;
        res.json({ success: false, message: `Gagal: ${errorData}` });
    }
});

module.exports = router;
