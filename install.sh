#!/bin/bash

echo "🦖 Dino-Bill Auto Installer for Ubuntu"
echo "---------------------------------------"

# Update system
sudo apt update && sudo apt upgrade -y

# Install Node.js
if ! command -v node &> /dev/null
then
    echo "Installing Node.js..."
    curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
    sudo apt install -y nodejs
fi

# Install MySQL
if ! command -v mysql &> /dev/null
then
    echo "Installing MySQL..."
    sudo apt install -y mysql-server
fi

# Install Git
sudo apt install -y git

# Install PM2
sudo npm install -g pm2

# Clone and Install App (If not exists)
if [ ! -d "Dino-Bill" ]; then
    echo "Cloning Dino-Bill repository..."
    # Replace the URL with your actual GitHub repo URL
    git clone https://github.com/ittosolution-png/Dino-Bill.git
    cd Dino-Bill
    npm install
else
    cd Dino-Bill
    git pull
    npm install
fi

# Setup PM2
pm2 start server.js --name dino-bill
pm2 save
pm2 startup

echo "---------------------------------------"
echo "✅ Instalasi Selesai!"
echo "Akses Web Installer di http://$(hostname -I | awk '{print $1}'):3000"
echo "---------------------------------------"
