# Dino-Bill - ISP Management System 🦖

Dino-Bill adalah sistem manajemen billing dan operasional ISP (Internet Service Provider) yang dirancang untuk berjalan secara autopilot. Terintegrasi dengan MikroTik (PPPoE), GenieACS (ONT Management), dan Tripay Payment Gateway.

## Fitur Utama
- **Autopilot Billing**: Pembuatan invoice otomatis setiap bulan.
- **Auto-Isolation**: Pemutusan internet otomatis bagi pelanggan menunggak.
- **Payment Gateway**: Pembayaran otomatis via Tripay (QRIS, VA, E-Wallet).
- **Portal Pelanggan**: Cek tagihan, lapor gangguan, dan ganti Nama/Password WiFi sendiri.
- **Portal Teknisi & Sales**: Manajemen tugas lapangan dan lead penjualan.
- **Notifikasi WhatsApp**: Pengiriman invoice, pengingat, dan bukti bayar otomatis.
- **Integrasi OLT & ACS**: Pantau status ONT dan manajemen perangkat dari satu dashboard.

## Persyaratan Sistem
- Ubuntu Server 20.04/22.04
- Node.js v18+
- MySQL / MariaDB Server
- Git

## Instalasi Cepat (Ubuntu)
Jalankan perintah satu baris ini di terminal Ubuntu Anda:

```bash
curl -sSL https://raw.githubusercontent.com/ittosolution-png/Dino-Bill/main/install.sh | bash
```

## Instalasi Manual
1. Clone repository:
   ```bash
   git clone https://github.com/ittosolution-png/Dino-Bill.git
   cd Dino-Bill
   ```
2. Install dependencies:
   ```bash
   npm install
   ```
3. Jalankan aplikasi:
   ```bash
   node server.js
   ```
4. Buka browser dan akses `http://ip-server:3000` untuk memulai Web Installer.

##Support join group
- https://t.me/+VoVsmfje56A3Mjdl
## Lisensi
MIT License - Bebas dikembangkan untuk kebutuhan ISP lokal.
