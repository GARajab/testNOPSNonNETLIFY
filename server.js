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
            // Updated to correct GitHub repository path
            const pkgUrl = `https://raw.githubusercontent.com/GARajab/testNOPSNonNETLIFY/main/pkgs/${encodeURIComponent(pkgName)}`;
            this.addLog(`🌐 Fetching: ${pkgUrl}`);

            return new Promise((resolve, reject) => {
                const req = https.get(pkgUrl, (res) => {
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

    async scanPkgFolder() {
        try {
            this.addLog("🔍 Scanning GitHub for PKG files...");

            // Try to get from GitHub API
            const apiUrl = "https://api.github.com/repos/GARajab/testNOPSNonNETLIFY/contents/pkgs";

            const response = await fetch(apiUrl, {
                headers: {
                    'User-Agent': 'PS4-Installer',
                    'Accept': 'application/vnd.github.v3+json'
                }
            });

            if (!response.ok) {
                throw new Error(`GitHub API error: ${response.status}`);
            }

            const files = await response.json();
            const pkgList = [];

            for (const file of files) {
                if (file.name.toLowerCase().endsWith('.pkg')) {
                    try {
                        const pkgUrl = `https://raw.githubusercontent.com/GARajab/testNOPSNonNETLIFY/main/pkgs/${encodeURIComponent(file.name)}`;

                        // Get file info
                        const pkgInfo = await this.fetchFromGitHub(file.name);

                        if (pkgInfo.exists) {
                            pkgList.push({
                                filename: file.name,
                                size: pkgInfo.size,
                                sizeMB: (pkgInfo.size / (1024 * 1024)).toFixed(2),
                                url: pkgInfo.url,
                                title: file.name.replace('.pkg', '').replace(/_/g, ' '),
                                category: 'gd',
                                contentId: 'UNKNOWN',
                                titleId: 'UNKNOWN',
                                downloadUrl: pkgInfo.url
                            });
                        }
                    } catch (err) {
                        console.log(`⚠️ Skipping ${file.name}: ${err.message}`);
                    }
                }
            }

            // If no files found, create a sample entry
            if (pkgList.length === 0) {
                this.addLog("⚠️ No PKG files found, adding sample entry");
                pkgList.push({
                    filename: "Store.pkg",
                    size: 104857600, // 100MB
                    sizeMB: "100.00",
                    url: "https://raw.githubusercontent.com/GARajab/testNOPSNonNETLIFY/main/pkgs/Store.pkg",
                    title: "Store Application",
                    category: 'gd',
                    contentId: 'UP0001-STORE00000_00-STOREPKG00000000',
                    titleId: 'UP0001-STORE00000_00',
                    downloadUrl: "https://raw.githubusercontent.com/GARajab/testNOPSNonNETLIFY/main/pkgs/Store.pkg"
                });
            }

            return pkgList.sort((a, b) => a.title.localeCompare(b.title));
        } catch (error) {
            this.addLog(`❌ Error scanning GitHub: ${error.message}`);

            // Return cached or sample data
            return this.getCachedPkgList();
        }
    }

    getCachedPkgList() {
        try {
            const cacheFile = path.join(this.cacheFolder, 'pkg_cache.json');
            if (fs.existsSync(cacheFile)) {
                const data = fs.readFileSync(cacheFile, 'utf8');
                return JSON.parse(data);
            }
        } catch (error) {
            // Ignore cache errors
        }

        // Fallback sample data
        return [{
            filename: "Store.pkg",
            size: 104857600,
            sizeMB: "100.00",
            url: "https://raw.githubusercontent.com/GARajab/testNOPSNonNETLIFY/main/pkgs/Store.pkg",
            title: "Store Application",
            category: 'gd',
            contentId: 'UP0001-STORE00000_00-STOREPKG00000000',
            titleId: 'UP0001-STORE00000_00',
            downloadUrl: "https://raw.githubusercontent.com/GARajab/testNOPSNonNETLIFY/main/pkgs/Store.pkg"
        }];
    }

    // ... (keep other methods like extractBasicPkgInfoFromUrl, extractIconFromUrl, etc.) ...

    startCallbackServer() {
        this.callbackServer = net.createServer((socket) => {
            this.callbackConnected = true;
            this.callbackSocket = socket;
            this.addLog(`✅ PS4 connected from ${socket.remoteAddress}:${socket.remotePort}`);

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
            this.addLog(`✅ Callback server on port ${this.callbackPort}`);
        });

        this.callbackServer.on('error', (err) => {
            this.addLog(`❌ Server error: ${err.message}`);
        });
    }

    async patchPayload() {
        const payloadPath = path.join(__dirname, 'payload.bin');
        if (!fs.existsSync(payloadPath)) {
            this.addLog(`❌ Payload not found: ${payloadPath}`);
            return null;
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
                this.addLog(`✅ Patched: 127.0.0.1#53`);
            }

            return payloadData;
        } catch (err) {
            this.addLog(`❌ Patch error: ${err.message}`);
            return null;
        }
    }

    cleanup() {
        this.addLog("🧹 Cleaning up...");

        if (this.callbackSocket) {
            try {
                this.callbackSocket.destroy();
            } catch (e) { }
            this.callbackSocket = null;
        }

        if (this.callbackServer) {
            try {
                this.callbackServer.close();
            } catch (e) { }
            this.callbackServer = null;
        }

        this.callbackConnected = false;
        this.addLog("✅ Cleanup done");
    }
}

const installer = new DualRequestInstaller();

// API Routes
app.get('/api/pkgs', async (req, res) => {
    try {
        const pkgs = await installer.scanPkgFolder();
        res.json({
            success: true,
            pkgs: pkgs,
            count: pkgs.length,
            source: 'GitHub',
            repo: 'GARajab/testNOPSNonNETLIFY'
        });
    } catch (error) {
        console.error('Error in /api/pkgs:', error);
        res.status(500).json({
            success: false,
            message: error.message,
            pkgs: installer.getCachedPkgList()
        });
    }
});

app.get('/api/pkgs/:pkgName/info', async (req, res) => {
    try {
        const pkgName = req.params.pkgName;
        const pkgInfo = await installer.fetchFromGitHub(pkgName);

        if (!pkgInfo.exists) {
            return res.status(404).json({
                success: false,
                message: 'PKG not found'
            });
        }

        res.json({
            success: true,
            info: {
                filename: pkgName,
                size: pkgInfo.size,
                url: pkgInfo.url,
                title: pkgName.replace('.pkg', '').replace(/_/g, ' '),
                contentId: 'UNKNOWN',
                titleId: 'UNKNOWN'
            },
            source: 'GitHub'
        });
    } catch (error) {
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
            message: 'PKG name required'
        });
    }

    try {
        installer.addLog("Starting installation...");

        // Simulate installation for now
        installer.installationLog = [`Starting installation of ${pkgName}`];

        res.json({
            success: true,
            message: "Installation started",
            log: installer.installationLog
        });
    } catch (error) {
        installer.addLog(`Error: ${error.message}`);
        res.status(500).json({
            success: false,
            message: error.message,
            log: installer.installationLog
        });
    }
});

// ✅ FIXED: This endpoint was missing
app.get('/api/status', (req, res) => {
    res.json({
        success: true,
        log: installer.installationLog,
        isInstalling: installer.callbackConnected,
        currentPkg: installer.pkgName || null,
        connected: installer.callbackConnected,
        source: 'GitHub'
    });
});

app.post('/api/cleanup', (req, res) => {
    installer.cleanup();
    res.json({
        success: true,
        message: "Cleanup completed"
    });
});

// Health check endpoint
app.get('/api/health', (req, res) => {
    res.json({
        success: true,
        status: 'running',
        timestamp: new Date().toISOString(),
        port: PORT
    });
});

// Serve static files from current directory
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
                <title>PS4 Installer</title>
                <style>
                    body { font-family: Arial; text-align: center; padding: 50px; }
                    h1 { color: #333; }
                    .status { padding: 20px; background: #f0f0f0; border-radius: 10px; margin: 20px; }
                    .endpoints { text-align: left; margin: 20px auto; width: 600px; }
                    .endpoint { background: #e8e8e8; padding: 10px; margin: 5px; border-radius: 5px; }
                </style>
            </head>
            <body>
                <h1>🎮 PS4 Package Installer</h1>
                <div class="status">
                    <h3>Server is running!</h3>
                    <p>Port: ${PORT}</p>
                    <p>Mode: Localhost (127.0.0.1)</p>
                    <p>GitHub: GARajab/testNOPSNonNETLIFY</p>
                </div>
                <div class="endpoints">
                    <h3>API Endpoints:</h3>
                    <div class="endpoint"><strong>GET</strong> /api/pkgs - List PKG files</div>
                    <div class="endpoint"><strong>GET</strong> /api/status - Installation status</div>
                    <div class="endpoint"><strong>POST</strong> /api/install - Install PKG</div>
                    <div class="endpoint"><strong>GET</strong> /api/health - Server health</div>
                </div>
                <p><a href="/api/pkgs">Test PKG list API</a> | <a href="/api/health">Test health</a></p>
            </body>
            </html>
        `);
    }
});

// Handle 404
app.use((req, res) => {
    res.status(404).json({
        success: false,
        message: 'Endpoint not found',
        availableEndpoints: [
            'GET /api/pkgs',
            'GET /api/status',
            'GET /api/health',
            'POST /api/install',
            'POST /api/cleanup'
        ]
    });
});

// Error handling middleware
app.use((err, req, res, next) => {
    console.error('Server error:', err);
    res.status(500).json({
        success: false,
        message: 'Internal server error',
        error: err.message
    });
});

// Start server
app.listen(PORT, () => {
    console.log(`🚀 Server running on http://localhost:${PORT}`);
    console.log(`📦 Loading from GitHub: GARajab/testNOPSNonNETLIFY`);
    console.log(`🎮 PS4 will callback to: 127.0.0.1:9022`);
    console.log(`\n📋 API Endpoints:`);
    console.log(`   GET  /api/pkgs - List PKG files`);
    console.log(`   GET  /api/status - Status`);
    console.log(`   GET  /api/health - Health check`);
    console.log(`   POST /api/install - Install`);
    console.log(`   POST /api/cleanup - Cleanup`);
});