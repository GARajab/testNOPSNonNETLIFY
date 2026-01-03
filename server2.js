const express = require('express');
const cors = require('cors');
const net = require('net');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { Buffer } = require('buffer');
const { spawn } = require('child_process');

const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

class DualRequestInstaller {
    constructor() {
        this.pcIp = "192.168.100.150";
        this.ps4Ip = "192.168.100.179";
        this.callbackPort = 9022;
        this.npxPort = 8080;
        this.callbackConnected = false;
        this.callbackSocket = null;
        this.pkgSize = 0;
        this.pkgName = "";
        this.callbackServer = null;
        this.installationLog = [];
        this.pkgMetadata = null;
    }

    addLog(message) {
        const timestamp = new Date().toLocaleTimeString();
        const logEntry = `[${timestamp}] ${message}`;
        this.installationLog.push(logEntry);
        console.log(logEntry);
    }

    // Extract PKG metadata using Python script
    async extractPkgMetadata(pkgPath) {
        return new Promise((resolve) => {
            this.addLog(`📋 Extracting metadata from: ${pkgPath}`);
            
            const pythonScript = path.join(__dirname, 'pkg_metadata.py');
            const pythonProcess = spawn('python3', [pythonScript, pkgPath]);
            
            let stdout = '';
            let stderr = '';
            
            pythonProcess.stdout.on('data', (data) => {
                stdout += data.toString();
            });
            
            pythonProcess.stderr.on('data', (data) => {
                stderr += data.toString();
            });
            
            pythonProcess.on('close', (code) => {
                if (code === 0) {
                    try {
                        const metadata = JSON.parse(stdout);
                        if (metadata.error) {
                            this.addLog(`❌ Metadata extraction failed: ${metadata.error}`);
                            resolve(null);
                        } else {
                            this.addLog(`✅ Metadata extracted: ${metadata.content_name} (${metadata.id})`);
                            resolve(metadata);
                        }
                    } catch (e) {
                        this.addLog(`❌ Failed to parse metadata: ${e.message}`);
                        resolve(null);
                    }
                } else {
                    this.addLog(`❌ Python script failed: ${stderr}`);
                    resolve(null);
                }
            });
            
            pythonProcess.on('error', (err) => {
                this.addLog(`❌ Failed to run Python script: ${err.message}`);
                resolve(null);
            });
        });
    }

    // Create notification payload that can be sent to PS4
    createNotificationPayload(iconUri, message) {
        // This creates a payload that the PS4 can execute to show notification
        const notificationCode = `
            #include <ps4.h>
            
            void _start() {
                // Notification function using kernel API
                SceNotificationRequest buffer;
                
                // Format message
                snprintf(buffer.message, sizeof(buffer.message), "${message}");
                
                // Setup notification structure
                buffer.type = 0; // NotificationRequest
                buffer.unk3 = 0;
                buffer.useIconImageUri = 1;
                buffer.targetId = -1;
                snprintf(buffer.iconUri, sizeof(buffer.iconUri), "${iconUri}");
                
                // Send notification via kernel
                notification_write_from_kernel(0, &buffer, sizeof(SceNotificationRequest), 1);
            }
        `;
        
        // For now, we'll send a simple command to trigger notification
        // In a real implementation, this would be compiled to a payload
        const payload = Buffer.alloc(1024);
        
        // Simple notification trigger (placeholder)
        const notificationCommand = `NOTIFY:${iconUri}:${message}`;
        Buffer.from(notificationCommand).copy(payload);
        
        return payload;
    }

    // Send notification via payload to PS4
    async sendPS4Notification(iconUri, message) {
        return new Promise((resolve) => {
            const notificationPayload = this.createNotificationPayload(iconUri, message);
            
            const socket = net.createConnection({ host: this.ps4Ip, port: 9090 }, () => {
                socket.write(notificationPayload, () => {
                    socket.end();
                    this.addLog(`📢 Notification sent: ${message}`);
                    resolve(true);
                });
            });
            
            socket.on('error', (err) => {
                this.addLog(`❌ Notification error: ${err.message}`);
                resolve(false);
            });
            
            socket.setTimeout(3000, () => {
                this.addLog("❌ Notification timeout");
                socket.destroy();
                resolve(false);
            });
        });
    }

    async install(pkgName) {
        this.installationLog = [];
        this.addLog("🎮 DUAL REQUEST INSTALLER");
        this.addLog("==================================================");

        this.pkgName = pkgName;
        const pkgPath = path.join(process.cwd(), pkgName);
        const pkgUrl = `http://${this.pcIp}:${this.npxPort}/${pkgName}`;

        // Check if PKG file exists locally for metadata extraction
        if (!fs.existsSync(pkgPath)) {
            this.addLog(`❌ PKG file not found: ${pkgPath}`);
            this.addLog(`   Make sure the PKG file is in the same directory as server.js`);
            return false;
        }

        // Extract metadata from PKG file
        this.pkgMetadata = await this.extractPkgMetadata(pkgPath);
        if (!this.pkgMetadata) {
            this.addLog("⚠️ Using default metadata (extraction failed)");
            // Fallback to default metadata
            this.pkgMetadata = {
                id: "ED1633-PKGI13337_00-0000000000000000",
                content_name: pkgName.replace('.pkg', ''),
                package_type: "gd",
                package_size: 0
            };
        }

        // Check file size from NPX server
        this.addLog(`📡 Checking file on npx server: ${pkgUrl}`);
        try {
            this.pkgSize = await this.getFileSize(pkgUrl);
            this.addLog(`✅ Found package: ${pkgName}`);
            this.addLog(`💾 Size: ${this.pkgSize} bytes (${(this.pkgSize / (1024 * 1024)).toFixed(2)} MB)`);
            
            // Update package size in metadata if extraction failed
            if (this.pkgMetadata.package_size === 0) {
                this.pkgMetadata.package_size = this.pkgSize;
            }
        } catch (e) {
            this.addLog(`❌ Cannot access npx server: ${e.message}`);
            this.addLog(`   Make sure npx http-server is running on port ${this.npxPort}`);
            return false;
        }

        // Start callback server
        this.addLog(`📡 Starting callback server on port ${this.callbackPort}...`);
        this.startCallbackServer();

        // Patch payload
        const payload = await this.patchPayload();
        if (!payload) return false;

        // Send payload to PS4
        this.addLog("📤 Sending payload to PS4...");
        const sent = await this.sendPayload(payload);
        if (!sent) return false;

        // Wait for PS4 to connect back
        this.addLog("⏳ Waiting for PS4 to connect back...");
        const connected = await this.waitForCallback(30);
        if (!connected) {
            this.addLog("❌ PS4 did not connect back in time");
            return false;
        }

        // Send metadata (using extracted or fallback data)
        this.sendMetadata();

        // Stream file from NPX to PS4
        const success = await this.streamFileFromNpx(pkgUrl);
        
        if (success) {
            this.addLog("✅ Installation completed!");
            
            // Send success notification with actual package name
            const displayName = this.pkgMetadata.content_name || pkgName.replace('.pkg', '');
            setTimeout(async () => {
                await this.sendPS4Notification(
                    "cxml://psnotification/tex_default_icon_download",
                    `✅ ${displayName} installed successfully!`
                );
            }, 1000);
            
            // Auto cleanup after successful installation
            setTimeout(() => {
                this.cleanup();
            }, 3000);
        } else {
            this.addLog("❌ Installation failed");
            
            // Send error notification
            const displayName = this.pkgMetadata.content_name || pkgName.replace('.pkg', '');
            setTimeout(async () => {
                await this.sendPS4Notification(
                    "cxml://psnotification/tex_icon_ban",
                    `❌ ${displayName} installation failed`
                );
            }, 1000);
        }
        
        return success;
    }

    getFileSize(url) {
        return new Promise((resolve, reject) => {
            const req = http.request(url, { method: 'HEAD' }, (res) => {
                if (res.statusCode === 200) {
                    const length = res.headers['content-length'];
                    if (length) {
                        resolve(parseInt(length));
                    } else {
                        reject(new Error('Content-Length header not found'));
                    }
                } else {
                    reject(new Error(`HTTP ${res.statusCode}: ${res.statusMessage}`));
                }
            });
            
            req.on('error', (err) => {
                reject(new Error(`Network error: ${err.message}`));
            });
            
            req.setTimeout(5000, () => {
                req.destroy();
                reject(new Error('Timeout connecting to NPX server'));
            });
            
            req.end();
        });
    }

    startCallbackServer() {
        this.callbackServer = net.createServer((socket) => {
            this.callbackConnected = true;
            this.callbackSocket = socket;
            this.addLog(`✅ PS4 connected from ${socket.remoteAddress}`);
            
            // Setup socket event listeners immediately when connection is established
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

            socket.on('data', (data) => {
                // Handle any incoming data from PS4 if needed
                this.addLog(`📨 Received data from PS4: ${data.length} bytes`);
            });
        });
        
        this.callbackServer.listen(this.callbackPort, () => {
            this.addLog(`✅ Callback server listening on port ${this.callbackPort}`);
        });
        
        this.callbackServer.on('error', (err) => {
            this.addLog(`❌ Callback server error: ${err.message}`);
        });
    }

    waitForCallback(timeoutSeconds) {
        return new Promise((resolve) => {
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

    // In the DualRequestInstaller class, update the sendMetadata method:

sendMetadata() {
    if (!this.callbackSocket) {
        this.addLog("❌ No callback socket");
        return;
    }
    try {
        // Use extracted metadata or fallback to defaults
        const contentId = this.pkgMetadata.id || "UP9000-CUSA00000_00-0000000000000000";
        const bgftType = this.pkgMetadata.package_type || "fake";
        const pkgUrl = `http://${this.pcIp}:${this.npxPort}/${this.pkgName}`;
        const displayName = this.pkgMetadata.content_name || this.pkgName.replace('.pkg', '');

        // Use proper encoding for the data
        const urlData = Buffer.from(pkgUrl, 'utf-8');
        const nameData = Buffer.from(displayName, 'utf-8');
        const idData = Buffer.from(contentId, 'utf-8');
        const typeData = Buffer.from(bgftType, 'utf-8');

        // Calculate packet size
        const packetSize = 4 + 4 + urlData.length + 4 + nameData.length + 4 + idData.length + 4 + typeData.length + 8 + 4;
        const packet = Buffer.alloc(packetSize);
        let offset = 0;

        // Build the packet according to PS4 expected format
        packet.writeUInt32LE(1, offset); offset += 4; // Unknown but required
        packet.writeUInt32LE(urlData.length, offset); offset += 4;
        urlData.copy(packet, offset); offset += urlData.length;
        packet.writeUInt32LE(nameData.length, offset); offset += 4;
        nameData.copy(packet, offset); offset += nameData.length;
        packet.writeUInt32LE(idData.length, offset); offset += 4;
        idData.copy(packet, offset); offset += idData.length;
        packet.writeUInt32LE(typeData.length, offset); offset += 4;
        typeData.copy(packet, offset); offset += typeData.length;
        packet.writeBigUInt64LE(BigInt(this.pkgSize), offset); offset += 8;
        packet.writeUInt32LE(0, offset); // Unknown but required

        this.callbackSocket.write(packet);
        this.addLog("✅ Metadata sent");
        this.addLog(`   Content ID: ${contentId}`);
        this.addLog(`   Name: ${displayName}`);
        this.addLog(`   Type: ${bgftType}`);
        this.addLog(`   Size: ${this.pkgSize} bytes`);
        
    } catch (err) {
        this.addLog(`❌ Metadata error: ${err.message}`);
    }
}

    async streamFileFromNpx(pkgUrl) {
        if (!this.callbackSocket) {
            this.addLog("❌ No callback socket for streaming");
            return false;
        }
        
        this.addLog(`📥 Downloading from: ${pkgUrl}`);
        
        // Store reference to socket to avoid null issues
        const currentSocket = this.callbackSocket;
        let socketAlive = true;

        // Setup socket listeners for this specific stream
        const onClose = () => {
            this.addLog('🔌 PS4 disconnected during stream');
            socketAlive = false;
        };

        const onError = (err) => {
            this.addLog(`❌ Callback socket error during stream: ${err.message}`);
            socketAlive = false;
        };

        currentSocket.on('close', onClose);
        currentSocket.on('error', onError);

        return new Promise((resolve) => {
            http.get(pkgUrl, (res) => {
                if (res.statusCode !== 200) {
                    this.addLog(`❌ HTTP Error: ${res.statusCode}`);
                    // Cleanup socket listeners
                    currentSocket.removeListener('close', onClose);
                    currentSocket.removeListener('error', onError);
                    resolve(false);
                    return;
                }

                let sentBytes = 0;
                let lastReport = 0;

                res.on('data', (chunk) => {
                    if (!socketAlive || !currentSocket) {
                        this.addLog('🛑 Socket is closed, stopping stream.');
                        res.destroy();
                        return;
                    }
                    try {
                        currentSocket.write(chunk);
                        sentBytes += chunk.length;
                        if (sentBytes - lastReport >= 5 * 1024 * 1024) {
                            const progress = (sentBytes / this.pkgSize) * 100;
                            this.addLog(`📊 ${progress.toFixed(1)}% (${sentBytes}/${this.pkgSize} bytes)`);
                            lastReport = sentBytes;
                        }
                    } catch (err) {
                        this.addLog(`📭 Error during write: ${err.message}`);
                        res.destroy();
                    }
                });

                res.on('end', () => {
                    if (sentBytes === this.pkgSize) {
                        this.addLog(`✅ Transfer complete: ${sentBytes} bytes (100%)`);
                        // Cleanup socket listeners
                        currentSocket.removeListener('close', onClose);
                        currentSocket.removeListener('error', onError);
                        resolve(true);
                    } else {
                        this.addLog(`⚠️ Transfer incomplete: ${sentBytes}/${this.pkgSize} bytes`);
                        // Cleanup socket listeners
                        currentSocket.removeListener('close', onClose);
                        currentSocket.removeListener('error', onError);
                        resolve(false);
                    }
                });

                res.on('error', (err) => {
                    this.addLog(`❌ Stream error: ${err.message}`);
                    // Cleanup socket listeners
                    currentSocket.removeListener('close', onClose);
                    currentSocket.removeListener('error', onError);
                    resolve(false);
                });
            }).on('error', (err) => {
                this.addLog(`❌ HTTP request error: ${err.message}`);
                // Cleanup socket listeners
                currentSocket.removeListener('close', onClose);
                currentSocket.removeListener('error', onError);
                resolve(false);
            });
        });
    }

    async patchPayload() {
        const payloadPath = path.resolve('./payload.bin');
        if (!fs.existsSync(payloadPath)) {
            this.addLog(`❌ Payload not found: ${payloadPath}`);
            return null;
        }
        try {
            const payloadData = fs.readFileSync(payloadPath);
            const placeholder = Buffer.from([0xB4, 0xB4, 0xB4, 0xB4, 0xB4, 0xB4]);
            const offset = payloadData.indexOf(placeholder);
            if (offset === -1) {
                this.addLog("❌ Placeholder not found in payload");
                return null;
            }

            const ipBytes = Buffer.from(this.pcIp.split('.').map(Number));
            const portBytes = Buffer.alloc(2);
            portBytes.writeUInt16BE(this.callbackPort, 0);

            ipBytes.copy(payloadData, offset);
            portBytes.copy(payloadData, offset + 4);

            this.addLog(`✅ Payload patched: ${this.pcIp}:${this.callbackPort}`);
            return payloadData;
        } catch (err) {
            this.addLog(`❌ Patch error: ${err.message}`);
            return null;
        }
    }

    sendPayload(payload) {
        return new Promise((resolve) => {
            const socket = net.createConnection({ host: this.ps4Ip, port: 9090 }, () => {
                socket.write(payload, () => {
                    socket.end();
                    this.addLog("✅ Payload sent");
                    resolve(true);
                });
            });
            
            socket.on('error', (err) => {
                this.addLog(`❌ Send error: ${err.message}`);
                resolve(false);
            });
            
            socket.setTimeout(5000, () => {
                this.addLog("❌ Payload send timeout");
                socket.destroy();
                resolve(false);
            });
        });
    }

    cleanup() {
        this.addLog("🧹 Cleaning up connections...");
        
        if (this.callbackSocket) {
            try {
                this.callbackSocket.destroy();
                this.addLog("✅ Callback socket destroyed");
            } catch (e) {
                this.addLog(`⚠️ Error destroying callback socket: ${e.message}`);
            }
            this.callbackSocket = null;
        }
        
        if (this.callbackServer) {
            try {
                this.callbackServer.close();
                this.addLog("✅ Callback server closed");
            } catch (e) {
                this.addLog(`⚠️ Error closing callback server: ${e.message}`);
            }
            this.callbackServer = null;
        }
        
        this.callbackConnected = false;
        this.addLog("✅ Cleanup completed - Port 9022 is free");
    }
    // Add this method to the DualRequestInstaller class
async sendPS4NotificationWithIcon(iconData, message) {
    return new Promise((resolve) => {
        // If we have icon data, use it in the notification
        const iconUri = iconData ? 
            `data:image/png;base64,${iconData}` : 
            "cxml://psnotification/tex_default_icon_download";
        
        const notificationPayload = this.createNotificationPayload(iconUri, message);
        
        const socket = net.createConnection({ host: this.ps4Ip, port: 9090 }, () => {
            socket.write(notificationPayload, () => {
                socket.end();
                this.addLog(`📢 Notification sent with icon: ${message}`);
                resolve(true);
            });
        });
        
        socket.on('error', (err) => {
            this.addLog(`❌ Notification error: ${err.message}`);
            resolve(false);
        });
        
        socket.setTimeout(3000, () => {
            this.addLog("❌ Notification timeout");
            socket.destroy();
            resolve(false);
        });
    });
}

// Update the install method to use the icon
async install(pkgName) {
    // ... existing code ...
    
    if (success) {
        this.addLog("✅ Installation completed!");
        
        // Send success notification with actual package name AND icon
        const displayName = this.pkgMetadata.content_name || pkgName.replace('.pkg', '');
        setTimeout(async () => {
            await this.sendPS4NotificationWithIcon(
                this.pkgMetadata.icon_data, // Use extracted icon
                `✅ ${displayName} installed successfully!`
            );
        }, 1000);
        
        // Auto cleanup after successful installation
        setTimeout(() => {
            this.cleanup();
        }, 3000);
    } else {
        this.addLog("❌ Installation failed");
        
        // Send error notification
        const displayName = this.pkgMetadata.content_name || pkgName.replace('.pkg', '');
        setTimeout(async () => {
            await this.sendPS4Notification(
                "cxml://psnotification/tex_icon_ban",
                `❌ ${displayName} installation failed`
            );
        }, 1000);
    }
    
    return success;
}
}

// Global installer instance
const installer = new DualRequestInstaller();

// API Routes
app.post('/api/install', async (req, res) => {
    const { pkgName = "FPKGi_v1.00.0-release.pkg" } = req.body;
    
    try {
        installer.addLog("Starting installation...");
        const success = await installer.install(pkgName);
        res.json({ 
            success, 
            message: success ? "Installation completed" : "Installation failed",
            log: installer.installationLog
        });
    } catch (error) {
        installer.addLog(`Installation error: ${error.message}`);
        res.status(500).json({ 
            success: false, 
            message: error.message,
            log: installer.installationLog
        });
    }
});

app.get('/api/status', (req, res) => {
    res.json({ 
        log: installer.installationLog,
        isInstalling: installer.callbackConnected
    });
});

app.post('/api/cleanup', (req, res) => {
    installer.cleanup();
    res.json({ 
        success: true, 
        message: "Cleanup completed",
        log: installer.installationLog
    });
});

// New endpoint to get PKG metadata
app.post('/api/metadata', async (req, res) => {
    const { pkgName } = req.body;
    
    if (!pkgName) {
        return res.status(400).json({ error: "pkgName is required" });
    }
    
    const pkgPath = path.join(process.cwd(), pkgName);
    if (!fs.existsSync(pkgPath)) {
        return res.status(404).json({ error: "PKG file not found" });
    }
    
    try {
        const metadata = await installer.extractPkgMetadata(pkgPath);
        res.json(metadata);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Notification test endpoint
app.post('/api/test-notify', async (req, res) => {
    const { message = "Test notification from PS4 Installer" } = req.body;
    
    try {
        const success = await installer.sendPS4Notification(
            "cxml://psnotification/tex_default_icon_notification",
            message
        );
        res.json({ 
            success, 
            message: success ? "Test notification sent" : "Test notification failed"
        });
    } catch (error) {
        res.status(500).json({ 
            success: false, 
            message: error.message
        });
    }
});

app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
    console.log(`PS4 browser should access: http://YOUR_PC_IP:${PORT}`);
    console.log(`Make sure npx http-server is running on port ${installer.npxPort}`);
    console.log(`Command: npx http-server -p ${installer.npxPort} --cors`);
});