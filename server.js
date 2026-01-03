const express = require('express');
const cors = require('cors');
const net = require('net');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { Buffer } = require('buffer');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

class DualRequestInstaller {
    constructor() {
        this.pcIp = process.env.PC_IP || "192.168.100.150";
        this.ps4Ip = process.env.PS4_IP || "192.168.100.12";
        this.callbackPort = 9022;
        this.npxPort = 8080;
        this.callbackConnected = false;
        this.callbackSocket = null;
        this.pkgSize = 0;
        this.pkgName = "";
        this.pkgPath = "";
        this.callbackServer = null;
        this.installationLog = [];
        this.iconData = null;
        this.pkgInfo = null;
        this.pkgFolder = path.join(__dirname, 'pkgs');

        // Ensure PKG folder exists
        if (!fs.existsSync(this.pkgFolder)) {
            fs.mkdirSync(this.pkgFolder, { recursive: true });
            console.log(`📁 Created PKG folder: ${this.pkgFolder}`);
        }
    }

    addLog(message) {
        const timestamp = new Date().toLocaleTimeString();
        const logEntry = `[${timestamp}] ${message}`;
        this.installationLog.push(logEntry);
        console.log(logEntry);
    }

    scanPkgFolder() {
        try {
            if (!fs.existsSync(this.pkgFolder)) {
                fs.mkdirSync(this.pkgFolder, { recursive: true });
                return [];
            }

            const files = fs.readdirSync(this.pkgFolder);
            const pkgFiles = files.filter(file =>
                file.toLowerCase().endsWith('.pkg')
            );

            const pkgList = [];

            for (const pkgFile of pkgFiles) {
                try {
                    const pkgPath = path.join(this.pkgFolder, pkgFile);
                    const stats = fs.statSync(pkgPath);

                    // Check if it's a PKG file
                    const buffer = fs.readFileSync(pkgPath, { length: 4 });
                    const magic = buffer.readUInt32BE(0);

                    if (magic === 0x7F434E54) { // Valid PKG magic
                        const info = this.extractBasicPkgInfo(pkgPath);
                        pkgList.push({
                            filename: pkgFile,
                            size: stats.size,
                            sizeMB: (stats.size / (1024 * 1024)).toFixed(2),
                            path: pkgPath,
                            title: info.title || pkgFile.replace('.pkg', ''),
                            category: info.category || 'gd',
                            contentId: info.contentId || 'UNKNOWN',
                            titleId: info.titleId || 'UNKNOWN'
                        });
                    }
                } catch (err) {
                    console.log(`⚠️ Skipping ${pkgFile}: ${err.message}`);
                }
            }

            return pkgList.sort((a, b) => a.title.localeCompare(b.title));
        } catch (error) {
            console.log(`❌ Error scanning PKG folder: ${error.message}`);
            return [];
        }
    }

    extractBasicPkgInfo(pkgPath) {
        try {
            const buffer = fs.readFileSync(pkgPath, { length: 1024 * 1024 });
            const info = {
                title: '',
                category: 'gd',
                contentId: 'UNKNOWN',
                titleId: 'UNKNOWN'
            };

            // Look for param.sfo
            for (let i = 0; i < buffer.length - 4; i++) {
                if (buffer[i] === 0x00 && buffer[i + 1] === 0x50 &&
                    buffer[i + 2] === 0x53 && buffer[i + 3] === 0x46) {

                    const sfoOffset = i;
                    let offset = sfoOffset + 8;

                    const keyTableStart = buffer.readUInt32LE(offset); offset += 4;
                    const dataTableStart = buffer.readUInt32LE(offset); offset += 4;
                    const entryCount = buffer.readUInt32LE(offset); offset += 4;

                    for (let j = 0; j < entryCount; j++) {
                        const entryOffset = sfoOffset + 20 + (j * 16);
                        if (entryOffset + 16 > buffer.length) break;

                        const keyOffset = buffer.readUInt16LE(entryOffset);
                        const dataFormat = buffer.readUInt16LE(entryOffset + 2);
                        const dataLength = buffer.readUInt32LE(entryOffset + 4);
                        const dataOffset = buffer.readUInt32LE(entryOffset + 12);

                        // Read key name
                        const keyPos = sfoOffset + keyTableStart + keyOffset;
                        let keyName = "";
                        for (let k = 0; k < 50; k++) {
                            if (keyPos + k >= buffer.length) break;
                            const charCode = buffer[keyPos + k];
                            if (charCode === 0) break;
                            keyName += String.fromCharCode(charCode);
                        }

                        // Read data value
                        if (dataFormat === 0x0204 && dataLength > 0 && dataLength < 1000) {
                            const dataPos = sfoOffset + dataTableStart + dataOffset;
                            let value = "";

                            for (let k = 0; k < dataLength; k++) {
                                if (dataPos + k >= buffer.length) break;
                                const charCode = buffer[dataPos + k];
                                if (charCode === 0) break;
                                value += String.fromCharCode(charCode);
                            }

                            value = value.trim();

                            switch (keyName) {
                                case "TITLE":
                                    info.title = value;
                                    break;
                                case "CONTENT_ID":
                                    info.contentId = value;
                                    break;
                                case "TITLE_ID":
                                    info.titleId = value;
                                    break;
                                case "CATEGORY":
                                    info.category = value.toLowerCase();
                                    break;
                            }
                        }
                    }
                    break;
                }
            }

            return info;
        } catch (error) {
            return {
                title: path.basename(pkgPath).replace('.pkg', ''),
                category: 'gd',
                contentId: 'UNKNOWN',
                titleId: 'UNKNOWN'
            };
        }
    }

    extractIconFromPKG(pkgPath) {
        try {
            const pkgBuffer = fs.readFileSync(pkgPath);
            const fileSize = pkgBuffer.length;

            // Read PKG header magic
            const magic = pkgBuffer.readUInt32BE(0);

            if (magic !== 0x7F434E54) {
                return null;
            }

            // PKG Header offsets
            const entryTableOffset = pkgBuffer.readUInt32BE(0x58);
            const entryCount = pkgBuffer.readUInt32BE(0x5C);

            // Parse entry table
            let offset = entryTableOffset;
            let foundIcon = false;
            let iconOffset = 0;
            let iconSize = 0;

            for (let i = 0; i < entryCount; i++) {
                if (offset + 32 > fileSize) break;

                const id = pkgBuffer.readUInt32BE(offset);
                const dataSize = pkgBuffer.readUInt32BE(offset + 4);
                const dataOffset = pkgBuffer.readUInt32BE(offset + 8);

                if (id === 0x12 || id === 0x13) { // ICON0_PNG or ICON0_JPG
                    foundIcon = true;
                    iconOffset = dataOffset;
                    iconSize = dataSize;
                    break;
                }

                offset += 32;
            }

            if (!foundIcon) {
                return this.scanForImage(pkgBuffer, fileSize);
            }

            // Extract icon data
            if (iconOffset + iconSize > fileSize) {
                return null;
            }

            const iconBuffer = pkgBuffer.slice(iconOffset, iconOffset + iconSize);

            const isPNG = iconBuffer[0] === 0x89 && iconBuffer[1] === 0x50 &&
                iconBuffer[2] === 0x4E && iconBuffer[3] === 0x47;
            const isJPEG = iconBuffer[0] === 0xFF && iconBuffer[1] === 0xD8;

            if (isPNG || isJPEG) {
                return {
                    data: iconBuffer,
                    size: iconSize,
                    type: isPNG ? 'png' : 'jpeg'
                };
            }

            return null;

        } catch (error) {
            return null;
        }
    }

    scanForImage(pkgBuffer, fileSize) {
        // Look for PNG or JPEG in first 2MB
        const searchLimit = Math.min(fileSize, 2 * 1024 * 1024);

        for (let i = 0x1000; i < searchLimit - 8; i++) {
            // PNG
            if (pkgBuffer[i] === 0x89 && pkgBuffer[i + 1] === 0x50 &&
                pkgBuffer[i + 2] === 0x4E && pkgBuffer[i + 3] === 0x47) {

                let pngEnd = i;
                for (let j = i + 8; j < Math.min(i + 1024 * 1024, fileSize - 8); j++) {
                    if (pkgBuffer[j] === 0x49 && pkgBuffer[j + 1] === 0x45 &&
                        pkgBuffer[j + 2] === 0x4E && pkgBuffer[j + 3] === 0x44) {
                        pngEnd = j + 8;
                        break;
                    }
                }

                const pngSize = pngEnd - i;
                if (pngSize > 100 && pngSize < 1024 * 1024) {
                    return {
                        data: pkgBuffer.slice(i, pngEnd),
                        size: pngSize,
                        type: 'png'
                    };
                }
            }

            // JPEG
            if (pkgBuffer[i] === 0xFF && pkgBuffer[i + 1] === 0xD8 && pkgBuffer[i + 2] === 0xFF) {
                let jpegEnd = i;
                for (let j = i + 2; j < Math.min(i + 1024 * 1024, fileSize - 2); j++) {
                    if (pkgBuffer[j] === 0xFF && pkgBuffer[j + 1] === 0xD9) {
                        jpegEnd = j + 2;
                        break;
                    }
                }

                const jpegSize = jpegEnd - i;
                if (jpegSize > 100 && jpegSize < 1024 * 1024) {
                    return {
                        data: pkgBuffer.slice(i, jpegEnd),
                        size: jpegSize,
                        type: 'jpeg'
                    };
                }
            }
        }

        return null;
    }

    extractFullPkgInfo(pkgPath) {
        try {
            const pkgBuffer = fs.readFileSync(pkgPath);
            const fileSize = pkgBuffer.length;

            const info = {
                title: '',
                contentId: '',
                titleId: '',
                category: 'gd',
                systemVer: '01.00',
                version: '01.00',
                appType: '',
                parentalLevel: '0',
                attribute: '0',
                bgftType: 'gd',
                contentType: 'Game',
                devFlag: '0',
                downloadDataSize: '0',
                fsType: '0',
                klicensee: '',
                parentalLevelAge: '0',
                playTogetherFlag: '0',
                primaryFlag: '0',
                realId: '',
                skuFlag: '0',
                subTitle: '',
                thumbnail: '',
                uiCategory: 'default',
                filename: path.basename(pkgPath),
                filesize: fileSize,
                filesizeMB: (fileSize / (1024 * 1024)).toFixed(2)
            };

            // Find param.sfo
            let sfoOffset = -1;
            for (let i = 0; i < Math.min(pkgBuffer.length - 4, 0x100000); i++) {
                if (pkgBuffer[i] === 0x00 && pkgBuffer[i + 1] === 0x50 &&
                    pkgBuffer[i + 2] === 0x53 && pkgBuffer[i + 3] === 0x46) {
                    sfoOffset = i;
                    break;
                }
            }

            if (sfoOffset === -1) {
                return this.generateFallbackInfo(pkgPath);
            }

            // Parse param.sfo
            let offset = sfoOffset + 8;

            const keyTableStart = pkgBuffer.readUInt32LE(offset); offset += 4;
            const dataTableStart = pkgBuffer.readUInt32LE(offset); offset += 4;
            const entryCount = pkgBuffer.readUInt32LE(offset); offset += 4;

            for (let i = 0; i < entryCount; i++) {
                const entryOffset = sfoOffset + 20 + (i * 16);
                if (entryOffset + 16 > pkgBuffer.length) break;

                const keyOffset = pkgBuffer.readUInt16LE(entryOffset);
                const dataFormat = pkgBuffer.readUInt16LE(entryOffset + 2);
                const dataLength = pkgBuffer.readUInt32LE(entryOffset + 4);
                const dataOffset = pkgBuffer.readUInt32LE(entryOffset + 12);

                // Read key name
                const keyPos = sfoOffset + keyTableStart + keyOffset;
                let keyName = "";
                for (let j = 0; j < 100; j++) {
                    if (keyPos + j >= pkgBuffer.length) break;
                    const charCode = pkgBuffer[keyPos + j];
                    if (charCode === 0) break;
                    keyName += String.fromCharCode(charCode);
                }

                // Read data value
                if (dataFormat === 0x0204 && dataLength > 0 && dataLength < 10000) {
                    const dataPos = sfoOffset + dataTableStart + dataOffset;
                    let value = "";

                    for (let j = 0; j < dataLength; j++) {
                        if (dataPos + j >= pkgBuffer.length) break;
                        const charCode = pkgBuffer[dataPos + j];
                        if (charCode === 0) break;
                        value += String.fromCharCode(charCode);
                    }

                    value = value.trim();

                    info[keyName] = value;

                    switch (keyName) {
                        case "TITLE":
                            info.title = value;
                            break;
                        case "CONTENT_ID":
                            info.contentId = value;
                            break;
                        case "TITLE_ID":
                            info.titleId = value;
                            break;
                        case "CATEGORY":
                            info.category = value.toLowerCase();
                            info.bgftType = value.toLowerCase();
                            break;
                        case "SYSTEM_VER":
                        case "PS3_SYSTEM_VER":
                            info.systemVer = value;
                            break;
                        case "VERSION":
                            info.version = value;
                            break;
                        case "APP_TYPE":
                            info.appType = value;
                            break;
                        case "PARENTAL_LEVEL":
                            info.parentalLevel = value;
                            break;
                        case "ATTRIBUTE":
                            info.attribute = value;
                            break;
                        case "DEV_FLAG":
                            info.devFlag = value;
                            break;
                        case "DOWNLOAD_DATA_SIZE":
                            info.downloadDataSize = value;
                            break;
                        case "FS_TYPE":
                            info.fsType = value;
                            break;
                        case "KLICENSEE":
                            info.klicensee = value;
                            break;
                        case "PARENTAL_LEVEL_AGE":
                            info.parentalLevelAge = value;
                            break;
                        case "PLAY_TOGETHER_FLAG":
                            info.playTogetherFlag = value;
                            break;
                        case "PRIMARY_FLAG":
                            info.primaryFlag = value;
                            break;
                        case "REAL_ID":
                            info.realId = value;
                            break;
                        case "SKU_FLAG":
                            info.skuFlag = value;
                            break;
                        case "SUB_TITLE":
                            info.subTitle = value;
                            break;
                        case "THUMBNAIL":
                            info.thumbnail = value;
                            break;
                        case "UI_CATEGORY":
                            info.uiCategory = value;
                            break;
                    }
                } else if (dataFormat === 0x0404) {
                    const dataPos = sfoOffset + dataTableStart + dataOffset;
                    if (dataPos + 4 <= pkgBuffer.length) {
                        const intValue = pkgBuffer.readUInt32LE(dataPos);
                        info[keyName] = intValue.toString();
                    }
                }
            }

            // Determine content type
            if (info.category) {
                info.contentType = this.getContentType(info.category);
            }

            return info;

        } catch (error) {
            console.error('Error extracting full PKG info:', error.message);
            return this.generateFallbackInfo(pkgPath);
        }
    }

    generateFallbackInfo(pkgPath) {
        const filename = path.basename(pkgPath);
        const baseName = filename.replace('.pkg', '').replace(/_/g, ' ');

        return {
            title: baseName,
            contentId: `UNKNOWN-${Date.now().toString(16).toUpperCase()}`,
            titleId: 'UNKNOWN00000',
            category: 'gd',
            bgftType: 'gd',
            contentType: 'Game',
            systemVer: '01.00',
            version: '01.00',
            filename: filename,
            filesize: 0,
            filesizeMB: '0'
        };
    }

    getContentType(category) {
        const categories = {
            'ac': 'Additional Content',
            'bd': 'Blu-ray Disc',
            'gc': 'Game Content',
            'gd': 'Game Digital Application',
            'gda': 'System Application',
            'gdc': 'Non-Game Big Application',
            'gdd': 'BG Application',
            'gde': 'Non-Game Mini App / Video Service Native App',
            'gdk': 'Video Service Web App',
            'gdl': 'PS Cloud Beta App',
            'gdo': 'PS2 Classic',
            'gp': 'Game Application Patch',
            'gpc': 'Non-Game Big App Patch',
            'gpd': 'BG Application Patch',
            'gpe': 'Non-Game Mini App Patch / Video Service Native App Patch',
            'gpk': 'Video Service Web App Patch',
            'gpl': 'PS Cloud Beta App Patch',
            'sd': 'Save Data',
            'theme': 'Theme',
            'avatar': 'Avatar',
            'demo': 'Demo'
        };

        return categories[category.toLowerCase()] || `Unknown (${category})`;
    }

    async getFileSize(url) {
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

    async install(pkgName) {
        this.installationLog = [];
        this.addLog("🎮 DUAL REQUEST INSTALLER");
        this.addLog("==================================================");

        this.pkgName = pkgName;
        this.pkgPath = path.join(this.pkgFolder, pkgName);
        const pkgUrl = `http://${this.pcIp}:${this.npxPort}/pkgs/${encodeURIComponent(pkgName)}`;

        if (!fs.existsSync(this.pkgPath)) {
            this.addLog(`❌ PKG file not found: ${this.pkgPath}`);
            return false;
        }

        try {
            const stats = fs.statSync(this.pkgPath);
            this.addLog(`📦 File: ${pkgName}`);
            this.addLog(`💾 Size: ${stats.size} bytes (${(stats.size / (1024 * 1024)).toFixed(2)} MB)`);
        } catch (e) {
            this.addLog(`⚠️ Could not get file stats: ${e.message}`);
        }

        this.addLog(`🔍 Extracting PKG information...`);
        this.pkgInfo = this.extractFullPkgInfo(this.pkgPath);

        this.addLog(`📋 Title: ${this.pkgInfo.title}`);
        this.addLog(`📋 Content ID: ${this.pkgInfo.contentId}`);
        this.addLog(`📋 Title ID: ${this.pkgInfo.titleId}`);
        this.addLog(`📋 Category: ${this.pkgInfo.category} (${this.pkgInfo.contentType})`);
        this.addLog(`📋 Version: ${this.pkgInfo.version}`);

        this.addLog(`🖼️ Extracting icon from PKG...`);
        this.iconData = this.extractIconFromPKG(this.pkgPath);
        if (this.iconData) {
            this.addLog(`✅ Icon extracted: ${this.iconData.size} bytes (${this.iconData.type})`);
        } else {
            this.addLog("⚠️ No icon found in PKG");
        }

        this.addLog(`📡 Checking file on npx server: ${pkgUrl}`);
        try {
            this.pkgSize = await this.getFileSize(pkgUrl);
            this.addLog(`✅ NPX server file available`);
            this.addLog(`📊 NPX size: ${this.pkgSize} bytes (${(this.pkgSize / (1024 * 1024)).toFixed(2)} MB)`);
        } catch (e) {
            this.addLog(`❌ Cannot access npx server: ${e.message}`);
            this.addLog(`   Make sure npx http-server is running on port ${this.npxPort}`);
            this.addLog(`   Command: npx http-server -p ${this.npxPort} --cors`);
            return false;
        }

        this.addLog(`📡 Starting callback server on port ${this.callbackPort}...`);
        this.startCallbackServer();

        const payload = await this.patchPayload();
        if (!payload) return false;

        this.addLog("📤 Sending payload to PS4...");
        const sent = await this.sendPayload(payload);
        if (!sent) return false;

        this.addLog("⏳ Waiting for PS4 to connect back...");
        const connected = await this.waitForCallback(30);
        if (!connected) {
            this.addLog("❌ PS4 did not connect back in time");
            return false;
        }

        this.sendMetadata();

        await this.streamFileFromNpx(pkgUrl);
        this.addLog("✅ Installation completed!");

        setTimeout(() => {
            this.cleanup();
        }, 3000);

        return true;
    }

    startCallbackServer() {
        this.callbackServer = net.createServer((socket) => {
            this.callbackConnected = true;
            this.callbackSocket = socket;
            this.addLog(`✅ PS4 connected from ${socket.remoteAddress}`);

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

    sendMetadata() {
        if (!this.callbackSocket) {
            this.addLog("❌ No callback socket");
            return;
        }
        try {
            const contentId = this.pkgInfo.contentId;
            const bgftType = this.pkgInfo.category;
            const title = this.pkgInfo.title;
            const pkgUrl = `http://${this.pcIp}:${this.npxPort}/pkgs/${encodeURIComponent(this.pkgName)}`;

            const urlData = Buffer.from(pkgUrl, 'utf-8');
            const nameData = Buffer.from(title, 'utf-8');
            const idData = Buffer.from(contentId, 'utf-8');
            const typeData = Buffer.from(bgftType, 'utf-8');

            let totalSize = 4 + 4 + urlData.length + 4 + nameData.length + 4 +
                idData.length + 4 + typeData.length + 8 + 4 + 4 + 4;

            let iconSize = 0;
            if (this.iconData && this.iconData.data) {
                iconSize = this.iconData.data.length;
                totalSize += 4 + iconSize;
            }

            const packet = Buffer.alloc(totalSize);
            let offset = 0;

            const version = this.iconData ? 2 : 1;
            packet.writeUInt32LE(version, offset); offset += 4;

            packet.writeUInt32LE(urlData.length, offset); offset += 4;
            urlData.copy(packet, offset); offset += urlData.length;

            packet.writeUInt32LE(nameData.length, offset); offset += 4;
            nameData.copy(packet, offset); offset += nameData.length;

            packet.writeUInt32LE(idData.length, offset); offset += 4;
            idData.copy(packet, offset); offset += idData.length;

            packet.writeUInt32LE(typeData.length, offset); offset += 4;
            typeData.copy(packet, offset); offset += typeData.length;

            packet.writeBigUInt64LE(BigInt(this.pkgSize), offset); offset += 8;

            if (this.iconData && this.iconData.data) {
                packet.writeUInt32LE(iconSize, offset); offset += 4;
                this.iconData.data.copy(packet, offset); offset += iconSize;
                this.addLog(`🖼️ Icon included in metadata (${iconSize} bytes)`);
            } else {
                packet.writeUInt32LE(0, offset); offset += 4;
                this.addLog("ℹ️ No icon in metadata");
            }

            packet.writeUInt32LE(0, offset);

            this.callbackSocket.write(packet);
            this.addLog(`✅ Metadata sent for: ${title}`);
            this.addLog(`   Content ID: ${contentId}`);
            this.addLog(`   Type: ${bgftType}`);
        } catch (err) {
            this.addLog(`❌ Metadata error: ${err.message}`);
        }
    }

    async streamFileFromNpx(pkgUrl) {
        if (!this.callbackSocket) {
            this.addLog("❌ No callback socket for streaming");
            return;
        }

        this.addLog(`📥 Downloading from: ${pkgUrl}`);
        return new Promise((resolve) => {
            http.get(pkgUrl, (res) => {
                if (res.statusCode !== 200) {
                    this.addLog(`❌ HTTP Error: ${res.statusCode}`);
                    resolve();
                    return;
                }

                let sentBytes = 0;
                let lastReport = 0;
                let socketAlive = true;

                this.callbackSocket.on('close', () => {
                    this.addLog('🔌 Callback socket closed');
                    socketAlive = false;
                });

                this.callbackSocket.on('error', (err) => {
                    this.addLog(`❌ Callback socket error: ${err.message}`);
                    socketAlive = false;
                });

                res.on('data', (chunk) => {
                    if (!socketAlive) {
                        this.addLog('🛑 Socket is closed, stopping stream.');
                        res.destroy();
                        resolve();
                        return;
                    }
                    try {
                        this.callbackSocket.write(chunk);
                        sentBytes += chunk.length;
                        if (sentBytes - lastReport >= 5 * 1024 * 1024) {
                            const progress = (sentBytes / this.pkgSize) * 100;
                            this.addLog(`📊 ${progress.toFixed(1)}% (${sentBytes}/${this.pkgSize} bytes)`);
                            lastReport = sentBytes;
                        }
                    } catch (err) {
                        this.addLog(`📭 Error during write: ${err.message}`);
                        res.destroy();
                        resolve();
                    }
                });

                res.on('end', () => {
                    if (sentBytes === this.pkgSize) {
                        this.addLog(`✅ Transfer complete: ${sentBytes} bytes (100%)`);
                    } else {
                        this.addLog(`⚠️ Transfer incomplete: ${sentBytes}/${this.pkgSize} bytes`);
                    }
                    resolve();
                });

                res.on('error', (err) => {
                    this.addLog(`❌ Stream error: ${err.message}`);
                    resolve();
                });
            }).on('error', (err) => {
                this.addLog(`❌ HTTP request error: ${err.message}`);
                resolve();
            });
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
                this.addLog(`   Make sure PS4 is in debug mode and port 9090 is accessible`);
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
}

const installer = new DualRequestInstaller();

// API Routes
app.get('/api/pkgs', (req, res) => {
    try {
        const pkgs = installer.scanPkgFolder();
        res.json({
            success: true,
            pkgs: pkgs,
            count: pkgs.length,
            folder: installer.pkgFolder
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            message: error.message,
            pkgs: []
        });
    }
});

app.get('/api/pkgs/:pkgName/info', (req, res) => {
    try {
        const pkgName = req.params.pkgName;
        const pkgPath = path.join(installer.pkgFolder, pkgName);

        if (!fs.existsSync(pkgPath)) {
            return res.status(404).json({
                success: false,
                message: 'PKG file not found'
            });
        }

        const info = installer.extractFullPkgInfo(pkgPath);
        const icon = installer.extractIconFromPKG(pkgPath);

        const response = {
            success: true,
            info: info,
            hasIcon: !!icon,
            iconSize: icon ? icon.size : 0,
            iconType: icon ? icon.type : null
        };

        if (icon && req.query.includeIcon === 'true') {
            response.iconData = icon.data.toString('base64');
        }

        res.json(response);
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
            message: 'PKG name is required'
        });
    }

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
        isInstalling: installer.callbackConnected,
        currentPkg: installer.pkgName
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

// Serve PKG files
app.use('/pkgs', express.static(installer.pkgFolder));

// Serve HTML from root
app.get('/', (req, res) => {
    const indexPath = path.join(__dirname, 'index.html');
    if (fs.existsSync(indexPath)) {
        res.sendFile(indexPath);
    } else {
        res.send(`
            <html>
                <head><title>PS4 Installer</title>
                <style>
                    body { font-family: Arial; text-align: center; padding: 50px; }
                    h1 { color: #333; }
                    .error { color: red; }
                </style>
                </head>
                <body>
                    <h1>PS4 Package Installer</h1>
                    <p class="error">index.html file not found in root directory!</p>
                    <p>Please make sure index.html is in the same folder as server.js</p>
                </body>
            </html>
        `);
    }
});

// Serve static files from root if they exist
app.use(express.static(__dirname));

// Handle 404
app.use((req, res) => {
    res.status(404).send(`
        <html>
            <head><title>404 - Not Found</title></head>
            <body>
                <h1>404 - Page Not Found</h1>
                <p><a href="/">Go back to PS4 Installer</a></p>
            </body>
        </html>
    `);
});

// Start server
app.listen(PORT, () => {
    console.log(`🚀 Server running on http://localhost:${PORT}`);
    console.log(`📁 PKG folder: ${installer.pkgFolder}`);
    console.log(`\n📋 API Endpoints:`);
    console.log(`   GET  /api/pkgs - List all PKG files`);
    console.log(`   GET  /api/pkgs/{name}/info - Get PKG info`);
    console.log(`   POST /api/install - Install PKG`);
    console.log(`   GET  /api/status - Check installation status`);
    console.log(`   POST /api/cleanup - Cleanup connections`);
    console.log(`\n💡 Place your PKG files in the 'pkgs' folder`);
});