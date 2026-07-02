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

Dokumentasi Lengkap Alur Kerja Aplikasi (Dino-Bill Application Flow)
Aplikasi Dino-Bill adalah Sistem Manajemen ISP (Internet Service Provider) Premium yang mengintegrasikan penagihan pelanggan (billing), kontrol jaringan (MikroTik & RADIUS), pemantauan perangkat keras (OLT & ONU), pengelolaan tugas teknisi, dan portal penjualan.

Berikut adalah penjelasan lengkap alur kerja aplikasi dari awal hingga akhir.

1. Arsitektur Hak Akses & Peran (Role-Based Access Control)
Aplikasi ini dibagi menjadi 4 peran utama dengan antarmuka dan fungsi khusus:

Admin (Dashboard Utama - /dashboard): Mengelola seluruh sistem (pelanggan, billing, router, OLT, log, pengaturan pembayaran, inventaris, absensi, dan tiket gangguan).
Teknisi (Portal Teknisi - /technician): Melihat tugas instalasi baru, menyelesaikan tiket komplain, melakukan absensi berbasis GPS, serta memantau daya optik (redaman ONU) pelanggan secara real-time.
Sales (Portal Sales - /sales): Memasukkan data prospek (leads) pelanggan baru dan membuat voucher hotspot massal.
Portal Pelanggan (Customer Portal - /portal): Tempat pelanggan masuk menggunakan username PPPoE/No. Handphone untuk melihat tagihan, membayar tagihan (otomatis via Payment Gateway atau upload bukti manual), serta mengubah nama/password Wi-Fi secara mandiri.

2. Diagram Alur Siklus Hidup Pelanggan (Customer Lifecycle)
Fixed / Tanggal Tetap
Rolling / Jatuh Tempo 30 Hari
Ya
Tidak / Lewat Jatuh Tempo
Sales input Leads / Admin Daftarkan Pelanggan
Prorated Billing / Tagihan Prorata
Sinkronisasi Otomatis ke MikroTik / RADIUS
Teknisi Melakukan Instalasi Fisik & Setup Titik Koordinat Peta
Metode Penagihan?
Invoice Otomatis Terbuat Setiap Tanggal 1 oleh Cron
Invoice Terbuat Otomatis Setiap 30 Hari Setelah Bayar
Pelanggan Membayar Sebelum Jatuh Tempo?
Layanan Tetap Aktif / Sistem Buka Isolir
Cron Auto-Isolir Berjalan Pukul 00:00
Akun Terisolir di DB & Kecepatan Dibatasi/Matikan di MikroTik
Pelanggan Lakukan Pembayaran Duitku / Midtrans / Tripay / Xendit

3. Rincian Alur Kerja Setiap Tahapan
Tahap 1: Registrasi & Aktivasi Pelanggan Baru
Pendaftaran: Admin mendaftarkan pelanggan melalui menu Pelanggan. Data wajib meliputi nama, nomor WhatsApp, paket internet, router MikroTik yang digunakan, koordinat GPS (Latitude/Longitude), dan ODP (Optical Distribution Point) terdekat.
Logika Prorata (Prorated Billing):
Jika pelanggan aktif di pertengahan bulan, sistem secara otomatis menghitung tarif prorata berdasarkan sisa hari pemakaian sebelum masuk ke siklus bulanan penuh.
Contoh: Paket Rp300.000 aktif tanggal 15 (sisa 15 hari), maka invoice pertama yang terbit adalah Rp150.000.
Penyambungan MikroTik / RADIUS:
Setelah disimpan, sistem langsung terhubung ke MikroTik API atau RADIUS Database untuk membuat akun PPPoE Secret dengan profil kecepatan (speed limit) sesuai paket yang dipilih.
Peta Jalur Kabel: Jalur kabel drop core (Last Mile) dari ODP ke koordinat rumah pelanggan langsung terlukis secara otomatis di peta (dengan estimasi jarak kabel dalam satuan meter).
Tahap 2: Siklus Tagihan (Billing Cycle) & Notifikasi WhatsApp
Sistem menjalankan penagihan menggunakan dua metode:

Fixed Billing: Tagihan dibuat serentak setiap tanggal 1 pukul 06:00 AM melalui Cron Job bulanan. Tanggal jatuh tempo diset default tanggal 20.
Rolling Billing: Jika pelanggan membayar tagihan pada tanggal 25 ke atas, sistem secara otomatis mengalihkan metode ke Rolling. Tagihan berikutnya akan terbit 30 hari ke depan terhitung sejak tanggal pembayaran terakhir.
Notifikasi WhatsApp:

Saat invoice dibuat, sistem mengirimkan pesan tagihan otomatis ke nomor WhatsApp pelanggan (misal via Fonnte atau Gateway Lokal).
Untuk mencegah spam block dari WhatsApp, pengiriman dibatasi oleh parameter wa_limit (maksimal pengiriman per batch) dan diberikan jeda waktu wa_delay (misal jeda 5 detik antar pesan).
Tahap 3: Pembayaran & Integrasi Payment Gateway
Pelanggan dapat membayar tagihan dengan cara:
Manual: Transfer bank lalu mengunggah bukti bayar di Portal Pelanggan. Admin akan memverifikasi di panel admin dan menekan tombol "Lunas".
Otomatis: Menggunakan payment gateway (Duitku, Midtrans, Tripay, atau Xendit). Pelanggan memilih metode pembayaran (QRIS, Virtual Account, Retail Store) di portal.
Callback Otomatis: Saat transaksi sukses, Payment Gateway mengirimkan data callback (webhook) ke router API Dino-Bill. Sistem secara instan:
Mengubah status invoice menjadi paid (lunas).
Mencatat tanggal lunas dan metode pembayaran di database.
Mengirim notifikasi WhatsApp tanda terima pembayaran sukses kepada pelanggan.
Membuka isolir secara otomatis jika pelanggan tersebut sedang terisolir.
Tahap 4: Pengingat (Reminder) & Isolasi Otomatis (Auto-Isolir)
Reminder H-3 (Setiap Hari pukul 08:00 AM):
Cron Job mencari semua tagihan unpaid yang akan jatuh tempo dalam 3 hari ke depan dan mengirimkan pengingat pembayaran ke WhatsApp pelanggan.
Isolasi Otomatis (Setiap Hari pukul 00:00 AM):
Cron Job mengidentifikasi semua tagihan yang berstatus unpaid dan telah melewati tanggal jatuh tempo (due_date < hari ini).
Sistem memindahkan paket pelanggan aktif ke Paket Isolir (ID paket dengan flag is_isolir = 1). Di MikroTik, profil PPPoE mereka diturunkan ke profil isolir (kecepatan lambat) atau akunnya dinonaktifkan sepenuhnya.
Paket langganan asli disimpan sementara pada kolom original_package_id.
Mengirim WhatsApp pemberitahuan isolasi layanan kepada pelanggan.
Tahap 5: Pemantauan Jaringan & Gangguan (Monitoring & Ticketing)
OLT & ONU Monitoring:
Sistem secara berkala melakukan query data ONU (Optical Network Unit) ke perangkat OLT (Huawei, Hioso, dll).
Membaca redaman optik secara real-time (satuan dBm). Jika redaman berada di bawah batas wajar (misalnya lebih buruk dari -27 dBm), indikator sinyal akan berubah warna menjadi merah (tanda redaman jelek).
Telegram Status Bot:
Ketika ada PPPoE pelanggan yang tiba-tiba putus (offline) atau tersambung kembali (online), modul monitoring mengirimkan notifikasi instan ke grup Telegram Admin/Teknisi.
Ticketing:
Jika pelanggan mengalami gangguan, Admin membuat tiket laporan gangguan.
Tiket ditugaskan ke Teknisi tertentu. Teknisi dapat melihat koordinat rumah pelanggan di peta portal teknisi dan meluncur ke lokasi untuk memperbaiki masalah. Setelah selesai, teknisi menutup tiket dari HP mereka.


## Instalasi Cepat (Ubuntu)
Jalankan perintah satu baris ini di terminal Ubuntu Anda:

```bash
curl -sSL https://raw.githubusercontent.com/ittosolution-png/Dino-Bill/main/install.sh | bash
```
Buka browser dan akses `http://ip-server:3999` untuk memulai Web Installer.

## Support join group
- https://t.me/dinosupports
## Lisensi
MIT License - Bebas dikembangkan untuk kebutuhan ISP lokal.
