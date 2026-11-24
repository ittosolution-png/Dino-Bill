/**
 * Payment Helper - Shared Success Handler
 */
const mikrotikHelper = require('./mikrotik');
const { notifyPaymentReceived } = require('./notification');
const { logActivity } = require('./logger');
const { unisolateCustomer } = require('./customer_status');

/**
 * Handle a successful payment for an invoice
 * @param {Object} pool - DB Pool
 * @param {number|string} invoiceId - The database ID of the invoice
 * @param {string} paymentMethod - The name of the payment gateway / method
 */
async function handlePaymentSuccess(pool, invoiceId, paymentMethod, appLocals = {}) {
    try {
        console.log(`[Payment] Processing success for invoice #${invoiceId} via ${paymentMethod}`);
        
        // 1. Check if invoice exists and is unpaid
        const [[invoice]] = await pool.query('SELECT * FROM invoices WHERE id = ?', [invoiceId]);
        if (!invoice) {
            console.error(`[Payment] Invoice #${invoiceId} not found`);
            return { success: false, message: 'Invoice tidak ditemukan' };
        }
        if (invoice.status === 'paid') {
            console.log(`[Payment] Invoice #${invoiceId} is already paid`);
            return { success: true, message: 'Invoice sudah lunas' };
        }

        // 2. Mark invoice as paid
        await pool.query(
            "UPDATE invoices SET status = 'paid', paid_at = NOW(), payment_method = ? WHERE id = ?",
            [paymentMethod, invoiceId]
        );

        // 3. Get customer info
        const [[cust]] = await pool.query(
            `SELECT c.*, r.ip_address as r_ip, r.username as r_user, r.password as r_pass, r.port as r_port 
             FROM customers c 
             LEFT JOIN routers r ON c.router_id = r.id 
             WHERE c.id = ?`,
            [invoice.customer_id]
        );

        if (cust) {
            // 4. If customer is isolated, activate them
            if (cust.status === 'isolated') {
                await unisolateCustomer(pool, cust.id, appLocals)
                    .then(() => console.log(`[Payment] Activated and restored customer #${cust.id} (${cust.name})`))
                    .catch(e => console.error(`[Payment] Customer activation failed for #${cust.id}: ${e.message}`));
            }

            // 5. Send WhatsApp / Telegram notification
            await notifyPaymentReceived(pool, cust, invoice.amount)
                .catch(e => console.error(`[Payment] Failed to send notification: ${e.message}`));

            // 6. Rolling Billing Logic
            const today = new Date();
            const currentDay = today.getDate();
            let billingMethod = cust.billing_method || 'fixed';

            // Auto-switch to rolling if paid on/after 25th
            if (currentDay >= 25) {
                billingMethod = 'rolling';
                await pool.query("UPDATE customers SET billing_method = 'rolling' WHERE id = ?", [cust.id]);
            }

            // If rolling, generate next invoice due in 30 days
            if (billingMethod === 'rolling') {
                const nextDue = new Date();
                nextDue.setDate(nextDue.getDate() + 30);
                const nextDueStr = nextDue.toISOString().split('T')[0];

                // Check if invoice for next period already exists to avoid duplicates
                const [[exists]] = await pool.query(
                    'SELECT id FROM invoices WHERE customer_id = ? AND due_date = ?',
                    [cust.id, nextDueStr]
                );

                if (!exists) {
                    // Ambil data pelanggan terbaru setelah unisolate
                    const [[freshCust]] = await pool.query('SELECT package_id FROM customers WHERE id = ?', [cust.id]);
                    const targetPkgId = freshCust?.package_id || cust.package_id;

                    const [pkg] = await pool.query('SELECT price FROM packages WHERE id = ?', [targetPkgId]);
                    let amount = pkg[0] && pkg[0].price !== null && pkg[0].price !== undefined ? parseFloat(pkg[0].price) : 0;

                    // Fallback jika paket tidak ditemukan atau bernilai 0: gunakan nominal tagihan sebelumnya
                    if (amount <= 0 && invoice.amount && parseFloat(invoice.amount) > 0) {
                        amount = parseFloat(invoice.amount);
                    }

                    await pool.query(
                        'INSERT INTO invoices (customer_id, package_id, amount, due_date, status, description) VALUES (?, ?, ?, ?, ?, ?)',
                        [cust.id, targetPkgId, amount, nextDueStr, 'unpaid', 'Tagihan Rolling 30 Hari']
                    );
                    console.log(`[Payment] Generated next rolling invoice for ${cust.name} (Rp ${amount}) due on ${nextDueStr}`);
                }
            }
        }

        await logActivity(pool, 'system', cust.id, cust.name || 'Customer', 'Payment Success', null, `Payment ${invoice.amount} received via ${paymentMethod} for invoice #${invoiceId}`);
        return { success: true, message: 'Pembayaran berhasil diproses' };
    } catch (e) {
        console.error(`[Payment] Error processing success for invoice #${invoiceId}:`, e.message);
        return { success: false, message: e.message };
    }
}

module.exports = {
    handlePaymentSuccess
};
