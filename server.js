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
        // Localhost mode for PS4
        this.pcIp = "127.0.0.1#53";
        this.backendUrl = "https://testnopsnonnetlify.onrender.com";
        this.callbackPort = 9022;
        this.callbackConnected = false;
        this.callbackSocket = null;
        this.pkgSize = 0;
        this.pkgName = "";
        this.callbackServer = null;
        this.installationLog = [];
        this.iconData = null;
        this.pkgInfo = null;
        this.ps4Ip = "127.0.0.1";
        this.isInstalling = false;

        // Cache folder
        this.cacheFolder = path.join(__dirname, 'cache');
        if (!fs.existsSync(this.cacheFolder)) {
            fs.mkdirSync(this.cacheFolder, { recursive: true });
        }

        this.addLog(`✅ Installer initialized`);
        this.addLog(`🌐 Localhost mode: ${this.pcIp}`);
    }

    addLog(message) {
        const timestamp = new Date().toLocaleTimeString();
        const logEntry = `[${timestamp}] ${message}`;
        this.installationLog.push(logEntry);
        console.log(logEntry);
    }

    async fetchFromGitHub(pkgName) {
        try {
            const pkgUrl = `https://raw.githubusercontent.com/GARajab/testNOPSNonNETLIFY/main/pkgs/${encodeURIComponent(pkgName)}`;

            return new Promise((resolve, reject) => {
                const req = https.request(pkgUrl, { method: 'HEAD' }, (res) => {
                    if (res.statusCode === 200) {
                        const contentLength = res.headers['content-length'];
                        resolve({
                            url: pkgUrl,
                            size: contentLength ? parseInt(contentLength) : 0,
                            exists: true
                        });
                    } else if (res.statusCode === 404) {
                        resolve({
                            url: pkgUrl,
                            size: 0,
                            exists: false
                        });
                    } else {
                        reject(new Error(`HTTP ${res.statusCode}`));
                    }
                });

                req.on('error', reject);
                req.setTimeout(5000, () => {
                    req.destroy();
                    reject(new Error('Timeout'));
                });
                req.end();
            });
        } catch (error) {
            this.addLog(`❌ GitHub fetch error: ${error.message}`);
            throw error;
        }
    }

    async extractBasicPkgInfoFromUrl(pkgUrl) {
        try {
            // For now, return basic info without downloading
            const filename = path.basename(pkgUrl);
            return {
                title: filename.replace('.pkg', '').replace(/_/g, ' '),
                category: 'gd',
                contentId: `UP0001-${filename.replace('.pkg', '').toUpperCase()}00000`,
                titleId: `UP0001-${filename.replace('.pkg', '').toUpperCase()}00000_00`
            };
        } catch (error) {
            const filename = path.basename(pkgUrl);
            return {
                title: filename.replace('.pkg', '').replace(/_/g, ' '),
                category: 'gd',
                contentId: 'UNKNOWN',
                titleId: 'UNKNOWN'
            };
        }
    }

    async extractIconFromUrl(pkgUrl) {
        try {
            // Since we're not actually downloading the PKG, return null for icon
            return null;
        } catch (error) {
            return null;
        }
    }

    async getPkgInfo(pkgName) {
        try {
            const pkgInfo = await this.fetchFromGitHub(pkgName);

            if (!pkgInfo.exists) {
                return null;
            }

            const basicInfo = await this.extractBasicPkgInfoFromUrl(pkgInfo.url);
            const iconInfo = await this.extractIconFromUrl(pkgInfo.url);

            return {
                filename: pkgName,
                size: pkgInfo.size,
                sizeMB: (pkgInfo.size / (1024 * 1024)).toFixed(2),
                url: pkgInfo.url,
                title: basicInfo.title,
                category: basicInfo.category,
                contentId: basicInfo.contentId,
                titleId: basicInfo.titleId,
                hasIcon: iconInfo !== null,
                iconSize: iconInfo ? iconInfo.size : 0,
                iconType: iconInfo ? iconInfo.type : null,
                iconData: iconInfo ? iconInfo.data : null
            };
        } catch (error) {
            this.addLog(`❌ Error getting PKG info: ${error.message}`);
            return null;
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
            this.addLog(`✅ PS4 connected from ${socket.remoteAddress}:${socket.remotePort}`);

            socket.on('data', (data) => {
                this.addLog(`📨 Received ${data.length} bytes from PS4`);
            });

            socket.on('close', () => {
                this.addLog('🔌 PS4 disconnected');
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
            this.addLog(`✅ Callback server listening on port ${this.callbackPort}`);
            this.addLog(`   Waiting for PS4 to connect...`);
        });

        this.callbackServer.on('error', (err) => {
            this.addLog(`❌ Server error: ${err.message}`);
        });
    }

    waitForCallback(timeoutSeconds) {
        return new Promise((resolve) => {
            if (this.callbackConnected) {
                resolve(true);
                return;
            }

            let elapsed = 0;
            const interval = setInterval(() => {
                if (this.callbackConnected) {
                    clearInterval(interval);
                    resolve(true);
                } else {
                    elapsed++;
                    if (elapsed >= timeoutSeconds) {
                        clearInterval(interval);
                        resolve(false);
                    }
                }
            }, 1000);
        });
    }

    async patchPayload() {
        const payloadPath = path.join(__dirname, 'payload.bin');
        if (!fs.existsSync(payloadPath)) {
            this.addLog(`❌ Payload not found: ${payloadPath}`);
            this.addLog(`   Creating sample payload for testing...`);

            // Create a simple payload for testing
            const samplePayload = Buffer.alloc(1024);
            // Add placeholder bytes: 0xB4 0xB4 0xB4 0xB4 0xB4 0xB4
            samplePayload.writeUInt8(0xB4, 100);
            samplePayload.writeUInt8(0xB4, 101);
            samplePayload.writeUInt8(0xB4, 102);
            samplePayload.writeUInt8(0xB4, 103);
            samplePayload.writeUInt8(0xB4, 104);
            samplePayload.writeUInt8(0xB4, 105);

            // Patch with 127.0.0.1#53
            samplePayload.writeUInt8(0x7F, 100);  // 127
            samplePayload.writeUInt8(0x00, 101);  // 0
            samplePayload.writeUInt8(0x00, 102);  // 0
            samplePayload.writeUInt8(0x01, 103);  // 1
            samplePayload.writeUInt8(0x23, 104);  // #
            samplePayload.writeUInt8(0x35, 105);  // 5
            samplePayload.writeUInt8(0x33, 106);  // 3

            this.addLog(`✅ Created test payload with 127.0.0.1#53`);
            return samplePayload;
        }

        try {
            const payloadData = fs.readFileSync(payloadPath);

            // Patch with 127.0.0.1#53
            const placeholder = Buffer.from([0xB4, 0xB4, 0xB4, 0xB4, 0xB4, 0xB4]);
            const offset = payloadData.indexOf(placeholder);

            if (offset !== -1) {
                // 127.0.0.1#53 in bytes
                const localhostBytes = Buffer.from([0x7F, 0x00, 0x00, 0x01, 0x23, 0x35, 0x33]);
                localhostBytes.copy(payloadData, offset);
                this.addLog(`✅ Patched payload with 127.0.0.1#53`);
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
            this.addLog(`📤 Sending payload to ${this.ps4Ip}:9090`);

            const socket = new net.Socket();

            socket.on('connect', () => {
                this.addLog(`✅ Connected to PS4`);
                socket.write(payload, () => {
                    this.addLog(`✅ Payload sent`);
                    socket.end();
                    resolve(true);
                });
            });

            socket.on('error', (err) => {
                this.addLog(`❌ Connection error: ${err.message}`);
                this.addLog(`   Make sure PS4 is in debug mode and port 9090 is open`);
                socket.destroy();
                resolve(false);
            });

            socket.on('timeout', () => {
                this.addLog(`❌ Connection timeout`);
                socket.destroy();
                resolve(false);
            });

            // Try to connect to PS4
            socket.connect({
                host: this.ps4Ip,
                port: 9090
            });

            socket.setTimeout(5000);
        });
    }

    async streamFileFromGitHub(pkgUrl) {
        if (!this.callbackSocket || !this.callbackConnected) {
            this.addLog(`❌ No PS4 connection for streaming`);
            return;
        }

        this.addLog(`📥 Starting download from: ${pkgUrl}`);

        return new Promise((resolve) => {
            https.get(pkgUrl, (res) => {
                if (res.statusCode !== 200) {
                    this.addLog(`❌ Download failed: HTTP ${res.statusCode}`);
                    resolve();
                    return;
                }

                const contentLength = parseInt(res.headers['content-length']) || 0;
                this.addLog(`📦 File size: ${contentLength} bytes`);

                let downloaded = 0;
                let chunks = 0;

                res.on('data', (chunk) => {
                    if (!this.callbackConnected) {
                        this.addLog(`❌ PS4 disconnected, stopping download`);
                        res.destroy();
                        resolve();
                        return;
                    }

                    try {
                        this.callbackSocket.write(chunk);
                        downloaded += chunk.length;
                        chunks++;

                        // Log progress every 5MB
                        if (chunks % 100 === 0) {
                            const percent = contentLength > 0 ? ((downloaded / contentLength) * 100).toFixed(1) : '0';
                            this.addLog(`📊 Progress: ${percent}% (${downloaded}/${contentLength} bytes)`);
                        }
                    } catch (err) {
                        this.addLog(`❌ Stream error: ${err.message}`);
                        res.destroy();
                        resolve();
                    }
                });

                res.on('end', () => {
                    this.addLog(`✅ Download complete: ${downloaded} bytes`);
                    resolve();
                });

                res.on('error', (err) => {
                    this.addLog(`❌ Download error: ${err.message}`);
                    resolve();
                });
            }).on('error', (err) => {
                this.addLog(`❌ HTTP request error: ${err.message}`);
                resolve();
            });
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

            // Step 2: Start callback server
            this.addLog(`📡 Starting callback server on port ${this.callbackPort}...`);
            this.startCallbackServer();

            // Step 3: Patch and send payload
            this.addLog(`🔧 Preparing payload...`);
            const payload = await this.patchPayload();

            if (!payload) {
                this.addLog(`❌ Failed to prepare payload`);
                this.isInstalling = false;
                return false;
            }

            this.addLog(`📤 Sending payload to PS4...`);
            const payloadSent = await this.sendPayload(payload);

            if (!payloadSent) {
                this.addLog(`❌ Failed to send payload`);
                this.addLog(`   Make sure PS4 is in debug mode (Settings → Debug Settings)`);
                this.addLog(`   And that GoldHEN or similar is running`);
                this.isInstalling = false;
                return false;
            }

            // Step 4: Wait for PS4 to connect back
            this.addLog(`⏳ Waiting for PS4 to connect back (30 seconds)...`);
            const connected = await this.waitForCallback(30);

            if (!connected) {
                this.addLog(`❌ PS4 did not connect back`);
                this.addLog(`   Check if the payload was executed on PS4`);
                this.isInstalling = false;
                return false;
            }

            // Step 5: Send metadata
            this.addLog(`📋 Sending metadata...`);
            const basicInfo = await this.extractBasicPkgInfoFromUrl(pkgInfo.url);

            const metadata = {
                url: pkgInfo.url,
                title: basicInfo.title,
                contentId: basicInfo.contentId,
                type: basicInfo.category,
                size: this.pkgSize
            };

            if (this.callbackSocket) {
                const metadataStr = JSON.stringify(metadata);
                this.callbackSocket.write(metadataStr);
                this.addLog(`✅ Metadata sent: ${basicInfo.title}`);
            }

            // Step 6: Stream the file
            this.addLog(`🚀 Starting file transfer...`);
            await this.streamFileFromGitHub(pkgInfo.url);

            this.addLog(`✅ Installation completed!`);
            this.addLog(`✨ PKG should now appear on PS4 home screen`);

            // Auto cleanup after 5 seconds
            setTimeout(() => {
                this.cleanup();
            }, 5000);

            this.isInstalling = false;
            return true;

        } catch (error) {
            this.addLog(`❌ Installation error: ${error.message}`);
            this.isInstalling = false;
            return false;
        }
    }

    cleanup() {
        this.addLog("🧹 Cleaning up...");

        if (this.callbackSocket) {
            try {
                this.callbackSocket.destroy();
                this.addLog("✅ Socket destroyed");
            } catch (e) { }
            this.callbackSocket = null;
        }

        if (this.callbackServer) {
            try {
                this.callbackServer.close();
                this.addLog("✅ Server closed");
            } catch (e) { }
            this.callbackServer = null;
        }

        this.callbackConnected = false;
        this.isInstalling = false;
        this.addLog("✅ Cleanup completed");
    }
}

const installer = new DualRequestInstaller();

// API Routes
app.get('/api/pkgs', async (req, res) => {
    try {
        // Simulate PKG list
        const pkgs = [
            {
                filename: "Store.pkg",
                size: 157286400,
                sizeMB: "150.00",
                url: "https://raw.githubusercontent.com/GARajab/testNOPSNonNETLIFY/main/pkgs/Store.pkg",
                title: "PlayStation Store",
                category: 'gd',
                contentId: 'UP0001-CUSA00001_00-STORE00000000000',
                titleId: 'UP0001-CUSA00001_00'
            },
            {
                filename: "Demo.pkg",
                size: 1048576000,
                sizeMB: "1000.00",
                url: "https://raw.githubusercontent.com/GARajab/testNOPSNonNETLIFY/main/pkgs/Demo.pkg",
                title: "Game Demo",
                category: 'gd',
                contentId: 'UP0001-CUSA00002_00-DEMO00000000000',
                titleId: 'UP0001-CUSA00002_00'
            }
        ];

        res.json({
            success: true,
            pkgs: pkgs,
            count: pkgs.length,
            source: 'GitHub',
            repo: 'GARajab/testNOPSNonNETLIFY',
            instructions: "Ensure PS4 is in debug mode with GoldHEN running"
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            message: error.message,
            pkgs: []
        });
    }
});

// ✅ ADDED THIS ENDPOINT - PKG Info endpoint
app.get('/api/pkgs/:pkgName/info', async (req, res) => {
    try {
        const pkgName = req.params.pkgName;
        const includeIcon = req.query.includeIcon === 'true';

        installer.addLog(`ℹ️ Requesting info for: ${pkgName}`);

        const pkgInfo = await installer.getPkgInfo(pkgName);

        if (!pkgInfo) {
            return res.status(404).json({
                success: false,
                message: 'PKG not found'
            });
        }

        const response = {
            success: true,
            info: {
                filename: pkgInfo.filename,
                size: pkgInfo.size,
                sizeMB: pkgInfo.sizeMB,
                url: pkgInfo.url,
                title: pkgInfo.title,
                contentId: pkgInfo.contentId,
                titleId: pkgInfo.titleId,
                category: pkgInfo.category
            },
            hasIcon: pkgInfo.hasIcon,
            iconSize: pkgInfo.iconSize,
            iconType: pkgInfo.iconType,
            source: 'GitHub'
        };

        // Include icon data if requested
        if (includeIcon && pkgInfo.iconData) {
            response.iconData = pkgInfo.iconData.toString('base64');
        }

        res.json(response);
    } catch (error) {
        console.error('Error in /api/pkgs/:pkgName/info:', error);
        res.status(500).json({
            success: false,
            message: error.message
        });
    }
});

app.post('/api/install', async (req, res) => {
    const { pkgName } = req.body;

    if (!pkgName) {
        return res.status(400).json({
            success: false,
            message: 'PKG name is required'
        });
    }

    // Start installation in background
    installer.install(pkgName).then(success => {
        // Log is already updated in the installer
    }).catch(error => {
        installer.addLog(`Installation failed: ${error.message}`);
    });

    res.json({
        success: true,
        message: `Installation started for ${pkgName}`,
        log: installer.installationLog.slice(-10), // Last 10 log entries
        instructions: [
            "1. Make sure PS4 is in debug mode",
            "2. Ensure GoldHEN is running",
            "3. Check PS4 notifications for installation progress",
            "4. Installation may take several minutes"
        ]
    });
});

app.get('/api/status', (req, res) => {
    res.json({
        success: true,
        isInstalling: installer.isInstalling,
        currentPkg: installer.pkgName,
        callbackConnected: installer.callbackConnected,
        log: installer.installationLog,
        serverTime: new Date().toISOString(),
        callbackPort: installer.callbackPort,
        payloadIp: installer.pcIp
    });
});

app.post('/api/cleanup', (req, res) => {
    installer.cleanup();
    res.json({
        success: true,
        message: "Cleanup completed"
    });
});

app.get('/api/health', (req, res) => {
    res.json({
        success: true,
        status: 'running',
        port: PORT,
        mode: 'localhost',
        timestamp: new Date().toISOString(),
        endpoints: [
            '/api/pkgs',
            '/api/pkgs/:pkgName/info',
            '/api/install',
            '/api/status',
            '/api/cleanup',
            '/api/health'
        ]
    });
});

// Serve static files
app.use(express.static(__dirname));

// Serve index.html
app.get('/', (req, res) => {
    const indexPath = path.join(__dirname, 'index.html');
    if (fs.existsSync(indexPath)) {
        res.sendFile(indexPath);
    } else {
        res.send(`
            <!DOCTYPE html>
            <html>
            <head>
                <title>PS4 Installer - Localhost Mode</title>
                <style>
                    body { font-family: Arial, sans-serif; margin: 0; padding: 20px; background: #f5f5f5; }
                    .container { max-width: 800px; margin: 0 auto; background: white; padding: 30px; border-radius: 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
                    h1 { color: #0070cc; text-align: center; }
                    .status { background: #e8f4ff; padding: 15px; border-radius: 5px; margin: 20px 0; }
                    .log { background: #f8f8f8; padding: 15px; border-radius: 5px; font-family: monospace; font-size: 12px; max-height: 300px; overflow-y: auto; }
                    .button { background: #0070cc; color: white; border: none; padding: 10px 20px; border-radius: 5px; cursor: pointer; margin: 5px; }
                    .button:hover { background: #0055aa; }
                    .pkg-list { margin: 20px 0; }
                    .pkg-item { background: #f0f0f0; padding: 10px; margin: 5px 0; border-radius: 5px; display: flex; justify-content: space-between; align-items: center; }
                </style>
            </head>
            <body>
                <div class="container">
                    <h1>🎮 PS4 Package Installer</h1>
                    <div class="status">
                        <h3>Server Status: <span style="color: green;">● Running</span></h3>
                        <p>Port: ${PORT}</p>
                        <p>Mode: Localhost (127.0.0.1)</p>
                        <p>Callback Port: ${installer.callbackPort}</p>
                    </div>
                    
                    <h3>Available PKGs:</h3>
                    <div id="pkgList" class="pkg-list">
                        <div class="pkg-item">
                            <span>Store.pkg - 150 MB</span>
                            <button class="button" onclick="installPkg('Store.pkg')">Install</button>
                        </div>
                        <div class="pkg-item">
                            <span>Demo.pkg - 1000 MB</span>
                            <button class="button" onclick="installPkg('Demo.pkg')">Install</button>
                        </div>
                    </div>
                    
                    <div style="text-align: center; margin: 30px 0;">
                        <button class="button" onclick="loadPkgs()">Refresh PKG List</button>
                        <button class="button" onclick="checkStatus()">Check Status</button>
                        <button class="button" onclick="cleanup()">Cleanup</button>
                    </div>
                    
                    <h3>Installation Log:</h3>
                    <div id="log" class="log">
                        ${installer.installationLog.map(entry => `<div>${entry}</div>`).join('')}
                    </div>
                    
                    <h3>Requirements:</h3>
                    <ol>
                        <li>PS4 must be in debug mode</li>
                        <li>GoldHEN or similar must be running</li>
                        <li>Web browser open on PS4</li>
                        <li>Port 9090 must be accessible</li>
                    </ol>
                </div>
                
                <script>
                    async function loadPkgs() {
                        try {
                            const response = await fetch('/api/pkgs');
                            const data = await response.json();
                            if (data.success) {
                                const pkgListDiv = document.getElementById('pkgList');
                                pkgListDiv.innerHTML = data.pkgs.map(pkg => \`
                                    <div class="pkg-item">
                                        <span>\${pkg.title} - \${pkg.sizeMB} MB</span>
                                        <button class="button" onclick="installPkg('\${pkg.filename}')">Install</button>
                                    </div>
                                \`).join('');
                            }
                        } catch (error) {
                            console.error('Error loading PKGs:', error);
                        }
                    }
                    
                    async function installPkg(pkgName) {
                        try {
                            const response = await fetch('/api/install', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ pkgName })
                            });
                            const data = await response.json();
                            alert(data.message);
                            checkStatus();
                        } catch (error) {
                            alert('Error: ' + error.message);
                        }
                    }
                    
                    async function checkStatus() {
                        try {
                            const response = await fetch('/api/status');
                            const data = await response.json();
                            updateLog(data.log);
                        } catch (error) {
                            console.error('Status error:', error);
                        }
                    }
                    
                    async function cleanup() {
                        try {
                            const response = await fetch('/api/cleanup', { method: 'POST' });
                            const data = await response.json();
                            alert(data.message);
                            checkStatus();
                        } catch (error) {
                            alert('Error: ' + error.message);
                        }
                    }
                    
                    function updateLog(logEntries) {
                        const logDiv = document.getElementById('log');
                        logDiv.innerHTML = logEntries.map(entry => \`<div>\${entry}</div>\`).join('');
                        logDiv.scrollTop = logDiv.scrollHeight;
                    }
                    
                    // Auto-refresh status every 5 seconds
                    setInterval(checkStatus, 5000);
                    
                    // Load PKGs on page load
                    loadPkgs();
                </script>
            </body>
            </html>
        `);
    }
});

// Handle 404 for other routes
app.use((req, res) => {
    res.status(404).json({
        success: false,
        message: 'Endpoint not found',
        availableEndpoints: [
            'GET /api/pkgs',
            'GET /api/pkgs/:pkgName/info',
            'GET /api/status',
            'GET /api/health',
            'POST /api/install',
            'POST /api/cleanup'
        ]
    });
});

// Start server
app.listen(PORT, () => {
    console.log(`🚀 Server running on http://localhost:${PORT}`);
    console.log(`🎮 PS4 Installer - Localhost Mode`);
    console.log(`📡 Callback port: ${installer.callbackPort}`);
    console.log(`📦 Payload IP: ${installer.pcIp}`);
    console.log(`\n📋 Available API Endpoints:`);
    console.log(`   GET  /api/pkgs - List all PKG files`);
    console.log(`   GET  /api/pkgs/:pkgName/info - Get PKG info`);
    console.log(`   GET  /api/status - Installation status`);
    console.log(`   POST /api/install - Install PKG`);
    console.log(`   GET  /api/health - Server health`);
    console.log(`\n⚡ Ready for installation!`);
    console.log(`\n⚠️ IMPORTANT REQUIREMENTS:`);
    console.log(`   1. PS4 must be in debug mode`);
    console.log(`   2. GoldHEN or similar must be running`);
    console.log(`   3. Access this page from PS4 browser`);
    console.log(`   4. Port 9090 must be open on PS4`);
});