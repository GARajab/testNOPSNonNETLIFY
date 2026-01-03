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
        // Use localhost for PS4 callback - CRITICAL FIX
        this.pcIp = "127.0.0.1";  // Localhost for PS4 callback
        this.backendUrl = "https://testnopsnonnetlify.onrender.com";
        this.callbackPort = 9022;
        this.callbackConnected = false;
        this.callbackSocket = null;
        this.pkgSize = 0;
        this.pkgName = "";
        this.pkgPath = "";
        this.callbackServer = null;
        this.installationLog = [];
        this.iconData = null;
        this.pkgInfo = null;
        this.ps4Ip = "127.0.0.1";  // PS4 is the target for payload

        // This is important - the PS4 will connect back to 127.0.0.1:9022
        this.callbackHost = "127.0.0.1";

        // Local cache folder
        this.cacheFolder = path.join(__dirname, 'cache');
        if (!fs.existsSync(this.cacheFolder)) {
            fs.mkdirSync(this.cacheFolder, { recursive: true });
        }

        this.addLog(`🎯 Using localhost (127.0.0.1) for PS4 callback`);
        this.addLog(`📡 Callback server will listen on ${this.callbackHost}:${this.callbackPort}`);
    }

    addLog(message) {
        const timestamp = new Date().toLocaleTimeString();
        const logEntry = `[${timestamp}] ${message}`;
        this.installationLog.push(logEntry);
        console.log(logEntry);
    }

    // ... (keep all the GitHub fetch methods the same as before) ...

    startCallbackServer() {
        this.callbackServer = net.createServer((socket) => {
            this.callbackConnected = true;
            this.callbackSocket = socket;
            // Note: PS4 will connect from localhost since it's calling back to itself
            this.addLog(`✅ PS4 connected from ${socket.remoteAddress}:${socket.remotePort}`);
            this.addLog(`🔗 Local connection established`);

            socket.on('close', () => {
                this.addLog('🔌 PS4 disconnected');
                this.callbackConnected = false;
                this.callbackSocket = null;
            });

            socket.on('error', (err) => {
                this.addLog(`❌ Callback socket error: ${err.message}`);
                this.callbackConnected = false;
                this.callbackSocket = null;
            });
        });

        // Listen on all interfaces, but PS4 will connect to 127.0.0.1
        this.callbackServer.listen(this.callbackPort, '0.0.0.0', () => {
            this.addLog(`✅ Callback server listening on port ${this.callbackPort}`);
            this.addLog(`   PS4 should connect to: ${this.callbackHost}:${this.callbackPort}`);
        });

        this.callbackServer.on('error', (err) => {
            this.addLog(`❌ Callback server error: ${err.message}`);
        });
    }

    async patchPayload() {
        const payloadPath = path.join(__dirname, 'payload.bin');
        if (!fs.existsSync(payloadPath)) {
            this.addLog(`❌ Payload not found: ${payloadPath}`);
            this.addLog(`   Please ensure payload.bin is in the same directory as server.js`);
            return null;
        }
        try {
            const payloadData = fs.readFileSync(payloadPath);

            // First patch: Replace placeholder with 127.0.0.1#53
            const placeholder1 = Buffer.from([0xB4, 0xB4, 0xB4, 0xB4, 0xB4, 0xB4]);
            const offset1 = payloadData.indexOf(placeholder1);

            if (offset1 !== -1) {
                // Convert "127.0.0.1#53" to bytes
                // 127.0.0.1 = 0x7F 0x00 0x00 0x01
                // #53 = 0x23 0x35 0x33 (ASCII for '#53')
                const ipBytes = Buffer.from([0x7F, 0x00, 0x00, 0x01, 0x23, 0x35, 0x33]);
                ipBytes.copy(payloadData, offset1);
                this.addLog(`✅ IP placeholder patched: ${this.pcIp}`);
            }

            // Also patch any raw IP placeholders (4 bytes for IP + 2 bytes for port)
            const placeholder2 = Buffer.from([0xC0, 0xA8, 0x64, 0x96, 0x23, 0x36]); // Common placeholder
            const offset2 = payloadData.indexOf(placeholder2);

            if (offset2 !== -1) {
                // 127.0.0.1 port 9022 = 0x7F 0x00 0x00 0x01 0x23 0x36
                const localhostBytes = Buffer.from([0x7F, 0x00, 0x00, 0x01, 0x23, 0x36]);
                localhostBytes.copy(payloadData, offset2);
                this.addLog(`✅ Alternative placeholder patched`);
            }

            // Patch port (9022 = 0x23 0x36)
            const portPlaceholder = Buffer.from([0xB4, 0xB4]);
            for (let i = 0; i < payloadData.length - 1; i++) {
                if (payloadData[i] === 0xB4 && payloadData[i + 1] === 0xB4) {
                    payloadData[i] = 0x23;  // '#'
                    payloadData[i + 1] = 0x36; // '6' (for 9022 = #53 in ASCII but port 9022)
                    this.addLog(`✅ Port patched to 9022`);
                    break;
                }
            }

            return payloadData;
        } catch (err) {
            this.addLog(`❌ Patch error: ${err.message}`);
            return null;
        }
    }

    sendPayload(payload) {
        return new Promise((resolve) => {
            // IMPORTANT: Send to PS4's localhost (127.0.0.1) on port 9090
            const socket = net.createConnection({
                host: this.ps4Ip,  // 127.0.0.1
                port: 9090,
                timeout: 3000
            }, () => {
                socket.write(payload, () => {
                    socket.end();
                    this.addLog(`✅ Payload sent to ${this.ps4Ip}:9090`);
                    this.addLog(`📨 Payload contains: ${this.pcIp}`);
                    resolve(true);
                });
            });

            socket.on('error', (err) => {
                this.addLog(`❌ Send error: ${err.message}`);
                this.addLog(`   Make sure PS4 is in debug mode`);
                this.addLog(`   And port 9090 is accessible on localhost`);
                resolve(false);
            });

            socket.setTimeout(5000, () => {
                this.addLog("❌ Payload send timeout");
                socket.destroy();
                resolve(false);
            });
        });
    }

    // ... (keep the rest of your methods the same) ...

    async install(pkgName) {
        this.installationLog = [];
        this.addLog("🎮 DUAL REQUEST INSTALLER - LOCALHOST MODE");
        this.addLog("==================================================");
        this.addLog(`📌 PS4 will callback to: ${this.callbackHost}:${this.callbackPort}`);
        this.addLog(`📌 Using IP in payload: ${this.pcIp}`);

        this.pkgName = pkgName;

        // Get PKG from GitHub
        this.addLog(`🌐 Fetching PKG info from GitHub...`);
        const pkgInfo = await this.fetchFromGitHub(pkgName);

        if (!pkgInfo.exists) {
            this.addLog(`❌ PKG file not found on GitHub: ${pkgName}`);
            return false;
        }

        this.pkgSize = pkgInfo.size;
        const pkgUrl = pkgInfo.url;

        this.addLog(`📦 File: ${pkgName}`);
        this.addLog(`💾 Size: ${this.pkgSize} bytes (${(this.pkgSize / (1024 * 1024)).toFixed(2)} MB)`);
        this.addLog(`🔗 URL: ${pkgUrl}`);

        // Extract PKG information
        this.addLog(`🔍 Extracting PKG information...`);
        this.pkgInfo = await this.extractFullPkgInfoFromUrl(pkgUrl);

        this.addLog(`📋 Title: ${this.pkgInfo.title}`);
        this.addLog(`📋 Content ID: ${this.pkgInfo.contentId}`);
        this.addLog(`📋 Title ID: ${this.pkgInfo.titleId}`);
        this.addLog(`📋 Category: ${this.pkgInfo.category} (${this.pkgInfo.contentType})`);

        // Extract icon
        this.addLog(`🖼️ Extracting icon from PKG...`);
        this.iconData = await this.extractIconFromUrl(pkgUrl);
        if (this.iconData) {
            this.addLog(`✅ Icon extracted: ${this.iconData.size} bytes (${this.iconData.type})`);
        } else {
            this.addLog("⚠️ No icon found in PKG");
        }

        // Start callback server
        this.addLog(`📡 Starting callback server on port ${this.callbackPort}...`);
        this.startCallbackServer();

        // Patch payload with 127.0.0.1
        const payload = await this.patchPayload();
        if (!payload) return false;

        // Send payload to PS4's localhost
        this.addLog("📤 Sending payload to PS4 (127.0.0.1:9090)...");
        this.addLog("⚠️ IMPORTANT: This requires PS4 to be in debug mode!");
        const sent = await this.sendPayload(payload);
        if (!sent) return false;

        // Wait for PS4 to connect back
        this.addLog("⏳ Waiting for PS4 to connect back to 127.0.0.1:9022...");
        const connected = await this.waitForCallback(30);
        if (!connected) {
            this.addLog("❌ PS4 did not connect back in time");
            this.addLog("   Make sure the payload was executed successfully");
            return false;
        }

        // Send metadata
        this.sendMetadata(pkgUrl);

        // Stream file directly from GitHub to PS4
        await this.streamFileFromGitHub(pkgUrl);
        this.addLog("✅ Installation completed!");

        // Auto cleanup
        setTimeout(() => {
            this.cleanup();
        }, 3000);

        return true;
    }
}

const installer = new DualRequestInstaller();

// API Routes (keep these the same as before)
app.get('/api/pkgs', async (req, res) => {
    try {
        const pkgs = await installer.scanPkgFolder();
        res.json({
            success: true,
            pkgs: pkgs,
            count: pkgs.length,
            source: 'GitHub',
            repo: "GARajab/testNOPSNonNETLIFY",
            callbackInfo: {
                host: installer.callbackHost,
                port: installer.callbackPort,
                payloadIp: installer.pcIp
            }
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            message: error.message,
            pkgs: []
        });
    }
});

// ... (keep all other API routes the same) ...

app.get('/', (req, res) => {
    const indexPath = path.join(__dirname, 'index.html');
    if (fs.existsSync(indexPath)) {
        res.sendFile(indexPath);
    } else {
        res.send(`
            <html>
                <head><title>PS4 Installer - Localhost Mode</title>
                <style>
                    body { font-family: Arial; text-align: center; padding: 50px; }
                    h1 { color: #333; }
                    .important { color: red; font-weight: bold; }
                    .info { background: #f0f0f0; padding: 20px; border-radius: 10px; margin: 20px; }
                </style>
                </head>
                <body>
                    <h1>🎮 PS4 Package Installer - Localhost Mode</h1>
                    <div class="info">
                        <p class="important">⚠️ IMPORTANT: Using 127.0.0.1 (localhost) mode</p>
                        <p>PS4 will callback to: <strong>127.0.0.1:9022</strong></p>
                        <p>Payload contains: <strong>127.0.0.1#53</strong></p>
                        <p>📂 Loading PKG files from GitHub...</p>
                    </div>
                </body>
            </html>
        `);
    }
});

// Start server
app.listen(PORT, () => {
    console.log(`🚀 Server running on http://localhost:${PORT}`);
    console.log(`🎯 PS4 will callback to: 127.0.0.1:9022`);
    console.log(`📦 Payload IP: 127.0.0.1#53`);
    console.log(`\n⚠️ IMPORTANT: Make sure your payload.bin has the correct placeholder bytes!`);
    console.log(`   The placeholder should be: 0xB4 0xB4 0xB4 0xB4 0xB4 0xB4`);
    console.log(`   Which will be replaced with: 127.0.0.1#53`);
});