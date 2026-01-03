const express = require('express');
const cors = require('cors');
const net = require('net');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { Buffer } = require('buffer');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

class DualRequestInstaller {
    constructor() {
        // Detect if we're running on PS4 or PC
        this.isPS4Browser = false;
        this.callbackPort = 9022;
        this.callbackConnected = false;
        this.callbackSocket = null;
        this.pkgSize = 0;
        this.pkgName = "";
        this.callbackServer = null;
        this.installationLog = [];
        this.iconData = null;
        this.pkgInfo = null;
        this.isInstalling = false;

        // We'll detect the actual IP when installation starts
        this.targetIp = null;
        this.targetPort = 9090;

        // Cache folder
        this.cacheFolder = path.join(__dirname, 'cache');
        if (!fs.existsSync(this.cacheFolder)) {
            fs.mkdirSync(this.cacheFolder, { recursive: true });
        }

        this.addLog(`✅ Installer initialized`);
        this.addLog(`📡 Callback port: ${this.callbackPort}`);
    }

    addLog(message) {
        const timestamp = new Date().toLocaleTimeString();
        const logEntry = `[${timestamp}] ${message}`;
        this.installationLog.push(logEntry);
        console.log(logEntry);
    }

    // ... (keep all other methods like fetchFromGitHub, extractBasicPkgInfoFromUrl, etc.) ...

    async getLocalIP() {
        try {
            // This gets the server's local IP
            const interfaces = require('os').networkInterfaces();
            for (const name of Object.keys(interfaces)) {
                for (const iface of interfaces[name]) {
                    if (iface.family === 'IPv4' && !iface.internal) {
                        return iface.address;
                    }
                }
            }
            return '127.0.0.1';
        } catch (error) {
            return '127.0.0.1';
        }
    }

    startCallbackServer() {
        if (this.callbackServer) {
            this.addLog("⚠️ Callback server already running");
            return;
        }

        this.callbackServer = net.createServer((socket) => {
            this.callbackConnected = true;
            this.callbackSocket = socket;

            // Store the connecting IP - this might be the PS4's IP
            const remoteAddress = socket.remoteAddress;
            this.addLog(`✅ Connected from: ${remoteAddress}:${socket.remotePort}`);

            // If it's not localhost, use this IP for payload
            if (remoteAddress !== '127.0.0.1' && remoteAddress !== '::ffff:127.0.0.1') {
                this.targetIp = remoteAddress;
                this.addLog(`🎯 Detected PS4 IP: ${this.targetIp}`);
            }

            socket.on('data', (data) => {
                this.addLog(`📨 Received ${data.length} bytes`);
                // Try to parse what PS4 is sending
                try {
                    const text = data.toString('utf-8');
                    if (text.length < 100) {
                        this.addLog(`📝 Data: ${text}`);
                    }
                } catch (e) { }
            });

            socket.on('close', () => {
                this.addLog('🔌 Connection closed');
                this.callbackConnected = false;
                this.callbackSocket = null;
            });

            socket.on('error', (err) => {
                this.addLog(`❌ Socket error: ${err.message}`);
                this.callbackConnected = false;
                this.callbackSocket = null;
            });
        });

        this.callbackServer.listen(this.callbackPort, '0.0.0.0', () => {
            const serverIP = this.getLocalIP();
            this.addLog(`✅ Callback server listening on port ${this.callbackPort}`);
            this.addLog(`🌐 Server IP: ${serverIP}`);
            this.addLog(`   PS4 should connect to: ${serverIP}:${this.callbackPort}`);
        });

        this.callbackServer.on('error', (err) => {
            this.addLog(`❌ Server error: ${err.message}`);
        });
    }

    async patchPayload() {
        const payloadPath = path.join(__dirname, 'payload.bin');
        if (!fs.existsSync(payloadPath)) {
            this.addLog(`❌ Payload not found: ${payloadPath}`);
            this.addLog(`   Creating sample payload...`);

            // Create a simple payload
            const samplePayload = Buffer.alloc(1024);

            // Add placeholder for IP:PORT (6 bytes)
            samplePayload.writeUInt8(0xB4, 100);
            samplePayload.writeUInt8(0xB4, 101);
            samplePayload.writeUInt8(0xB4, 102);
            samplePayload.writeUInt8(0xB4, 103);
            samplePayload.writeUInt8(0xB4, 104);
            samplePayload.writeUInt8(0xB4, 105);

            // Get server IP to patch into payload
            const serverIP = await this.getLocalIP();
            this.addLog(`🔧 Patching payload with server IP: ${serverIP}#53`);

            // Convert IP to bytes
            const ipParts = serverIP.split('.');
            samplePayload.writeUInt8(parseInt(ipParts[0]), 100); // First octet
            samplePayload.writeUInt8(parseInt(ipParts[1]), 101); // Second octet
            samplePayload.writeUInt8(parseInt(ipParts[2]), 102); // Third octet
            samplePayload.writeUInt8(parseInt(ipParts[3]), 103); // Fourth octet
            samplePayload.writeUInt8(0x23, 104); // '#'
            samplePayload.writeUInt8(0x35, 105); // '5'
            samplePayload.writeUInt8(0x33, 106); // '3'

            this.addLog(`✅ Created payload with ${serverIP}#53`);
            return samplePayload;
        }

        try {
            const payloadData = fs.readFileSync(payloadPath);

            // Get server IP to patch into payload
            const serverIP = await this.getLocalIP();
            this.addLog(`🔧 Patching payload with server IP: ${serverIP}#53`);

            // Patch with server IP#53
            const placeholder = Buffer.from([0xB4, 0xB4, 0xB4, 0xB4, 0xB4, 0xB4]);
            const offset = payloadData.indexOf(placeholder);

            if (offset !== -1) {
                // Convert IP to bytes
                const ipParts = serverIP.split('.');
                payloadData.writeUInt8(parseInt(ipParts[0]), offset);     // First octet
                payloadData.writeUInt8(parseInt(ipParts[1]), offset + 1); // Second octet
                payloadData.writeUInt8(parseInt(ipParts[2]), offset + 2); // Third octet
                payloadData.writeUInt8(parseInt(ipParts[3]), offset + 3); // Fourth octet
                payloadData.writeUInt8(0x23, offset + 4); // '#'
                payloadData.writeUInt8(0x35, offset + 5); // '5'
                payloadData.writeUInt8(0x33, offset + 6); // '3'

                this.addLog(`✅ Patched payload with ${serverIP}#53`);
            } else {
                this.addLog(`⚠️ Placeholder not found, using payload as-is`);
            }

            return payloadData;
        } catch (err) {
            this.addLog(`❌ Patch error: ${err.message}`);
            return null;
        }
    }

    sendPayload(payload) {
        return new Promise((resolve) => {
            // Try different IPs to send payload to PS4
            const possibleIPs = [
                '192.168.1.100',  // Common PS4 IP
                '192.168.1.101',
                '192.168.1.102',
                '192.168.0.100',
                '192.168.0.101',
                '192.168.0.102',
                this.targetIp      // IP from callback connection
            ].filter(ip => ip);   // Remove null/undefined

            this.addLog(`🎯 Trying to send payload to PS4...`);

            let connected = false;
            let currentIndex = 0;

            const tryNextIP = () => {
                if (currentIndex >= possibleIPs.length) {
                    this.addLog(`❌ Could not connect to PS4 on any IP`);
                    this.addLog(`   Make sure PS4 is in debug mode with GoldHEN`);
                    resolve(false);
                    return;
                }

                const ip = possibleIPs[currentIndex];
                currentIndex++;

                this.addLog(`📤 Trying ${ip}:${this.targetPort}...`);

                const socket = new net.Socket();

                socket.on('connect', () => {
                    connected = true;
                    this.addLog(`✅ Connected to ${ip}:${this.targetPort}`);
                    socket.write(payload, () => {
                        this.addLog(`✅ Payload sent successfully!`);
                        socket.end();
                        this.targetIp = ip; // Save successful IP
                        resolve(true);
                    });
                });

                socket.on('error', (err) => {
                    if (!connected) {
                        socket.destroy();
                        // Try next IP after short delay
                        setTimeout(tryNextIP, 100);
                    }
                });

                socket.on('timeout', () => {
                    this.addLog(`⏱️ Timeout connecting to ${ip}`);
                    socket.destroy();
                    setTimeout(tryNextIP, 100);
                });

                // Try to connect
                socket.connect({
                    host: ip,
                    port: this.targetPort
                });

                socket.setTimeout(2000);
            };

            // Start trying IPs
            tryNextIP();
        });
    }

    async install(pkgName) {
        this.isInstalling = true;
        this.installationLog = [];
        this.addLog("🎮 STARTING INSTALLATION");
        this.addLog("==========================================");

        this.pkgName = pkgName;

        try {
            // Step 1: Get PKG info from GitHub
            this.addLog(`🔍 Fetching PKG info: ${pkgName}`);
            const pkgInfo = await this.fetchFromGitHub(pkgName);

            if (!pkgInfo.exists) {
                this.addLog(`❌ PKG not found on GitHub`);
                this.isInstalling = false;
                return false;
            }

            this.pkgSize = pkgInfo.size;
            this.addLog(`📦 File: ${pkgName}`);
            this.addLog(`💾 Size: ${this.pkgSize} bytes (${(this.pkgSize / (1024 * 1024)).toFixed(2)} MB)`);
            this.addLog(`🔗 URL: ${pkgInfo.url}`);

            // Step 2: Start callback server FIRST
            this.addLog(`📡 Starting callback server on port ${this.callbackPort}...`);
            this.startCallbackServer();

            // Step 3: Patch payload with SERVER'S IP (not 127.0.0.1)
            this.addLog(`🔧 Preparing payload...`);
            const payload = await this.patchPayload();

            if (!payload) {
                this.addLog(`❌ Failed to prepare payload`);
                this.isInstalling = false;
                return false;
            }

            // Step 4: Send payload to PS4
            this.addLog(`📤 Sending payload to PS4...`);
            const payloadSent = await this.sendPayload(payload);

            if (!payloadSent) {
                this.addLog(`❌ Failed to send payload`);
                this.addLog(`   PS4 requirements:`);
                this.addLog(`   1. Enable debug mode in Settings → Debug Settings`);
                this.addLog(`   2. Run GoldHEN or similar exploit`);
                this.addLog(`   3. Make sure port 9090 is accessible`);
                this.isInstalling = false;
                return false;
            }

            // Step 5: Wait for PS4 to connect back
            this.addLog(`⏳ Waiting for PS4 to connect back (60 seconds)...`);
            this.addLog(`   The PS4 should now connect to the callback server`);

            const connected = await this.waitForCallback(60);

            if (!connected) {
                this.addLog(`❌ PS4 did not connect back`);
                this.addLog(`   Possible issues:`);
                this.addLog(`   1. Payload not executed on PS4`);
                this.addLog(`   2. Firewall blocking connection`);
                this.addLog(`   3. Network configuration issue`);
                this.isInstalling = false;
                return false;
            }

            // Step 6: PS4 is now connected - send metadata
            this.addLog(`📋 PS4 connected! Sending metadata...`);
            const basicInfo = await this.extractBasicPkgInfoFromUrl(pkgInfo.url);

            const metadata = {
                action: "install",
                url: pkgInfo.url,
                title: basicInfo.title,
                contentId: basicInfo.contentId,
                type: basicInfo.category,
                size: this.pkgSize,
                timestamp: Date.now()
            };

            if (this.callbackSocket) {
                try {
                    const metadataStr = JSON.stringify(metadata);
                    this.callbackSocket.write(metadataStr);
                    this.addLog(`✅ Metadata sent: ${basicInfo.title}`);

                    // Wait a moment before starting transfer
                    await new Promise(resolve => setTimeout(resolve, 1000));
                } catch (err) {
                    this.addLog(`⚠️ Error sending metadata: ${err.message}`);
                }
            }

            // Step 7: Stream the file from GitHub to PS4
            this.addLog(`🚀 Starting file transfer from GitHub...`);
            await this.streamFileFromGitHub(pkgInfo.url);

            this.addLog(`✅ Installation completed!`);
            this.addLog(`✨ Check your PS4 notifications for installation progress`);
            this.addLog(`🎮 PKG should appear on home screen when complete`);

            // Auto cleanup after 10 seconds
            setTimeout(() => {
                this.cleanup();
            }, 10000);

            this.isInstalling = false;
            return true;

        } catch (error) {
            this.addLog(`❌ Installation error: ${error.message}`);
            this.isInstalling = false;
            return false;
        }
    }

    // ... (keep the rest of the methods: waitForCallback, streamFileFromGitHub, cleanup, etc.) ...
}

const installer = new DualRequestInstaller();

// API Routes (keep all your existing API routes)
app.get('/api/pkgs', async (req, res) => {
    try {
        // Get client IP for debugging
        const clientIP = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
        console.log(`Client IP: ${clientIP}`);

        // Simulate PKG list
        const pkgs = [
            {
                filename: "Store.pkg",
                size: 24772608,
                sizeMB: "23.63",
                url: "https://raw.githubusercontent.com/GARajab/testNOPSNonNETLIFY/main/pkgs/Store.pkg",
                title: "PlayStation Store",
                category: 'gd',
                contentId: 'UP0001-CUSA00001_00-STORE00000000000',
                titleId: 'UP0001-CUSA00001_00'
            }
        ];

        res.json({
            success: true,
            pkgs: pkgs,
            count: pkgs.length,
            source: 'GitHub',
            serverIP: await installer.getLocalIP(),
            callbackPort: installer.callbackPort,
            instructions: [
                "1. Ensure PS4 is in debug mode with GoldHEN",
                "2. Access this page from PS4 browser",
                "3. Click Install button",
                "4. Check PS4 notifications"
            ]
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            message: error.message,
            pkgs: []
        });
    }
});

// ... (keep all other API endpoints: /api/pkgs/:pkgName/info, /api/install, /api/status, etc.) ...

app.get('/api/server-info', async (req, res) => {
    const serverIP = await installer.getLocalIP();
    res.json({
        success: true,
        serverIP: serverIP,
        callbackPort: installer.callbackPort,
        targetPort: 9090,
        instructions: `PS4 should connect to: ${serverIP}:${installer.callbackPort}`
    });
});

// Start server
app.listen(PORT, async () => {
    const serverIP = await installer.getLocalIP();
    console.log(`🚀 Server running on http://localhost:${PORT}`);
    console.log(`🌐 Server IP: ${serverIP}`);
    console.log(`📡 Callback port: ${installer.callbackPort}`);
    console.log(`🎯 Target PS4 port: 9090`);
    console.log(`\n📋 IMPORTANT INSTRUCTIONS:`);
    console.log(`   1. Find your computer's IP: ${serverIP}`);
    console.log(`   2. On PS4 browser, go to: http://${serverIP}:${PORT}`);
    console.log(`   3. PS4 must be in debug mode with GoldHEN running`);
    console.log(`   4. Click Install button on the webpage`);
    console.log(`\n⚡ Ready for installation!`);
});