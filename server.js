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
        this.pcIp = "109.63.109.63"
        this.backendUrl = "https://testnopsnonnetlify.onrender.com"
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
        // this.githubRepo = "GARajab/testNOPSNonNETLIFY/tree/main";
        // this.githubRawBase = "https://raw.githubusercontent.com";

        // Local cache folder
        this.cacheFolder = path.join(__dirname, 'cache');
        if (!fs.existsSync(this.cacheFolder)) {
            fs.mkdirSync(this.cacheFolder, { recursive: true });
        }
    }

    addLog(message) {
        const timestamp = new Date().toLocaleTimeString();
        const logEntry = `[${timestamp}] ${message}`;
        this.installationLog.push(logEntry);
        console.log(logEntry);
    }

    async fetchFromGitHub(pkgName) {
        try {
            const pkgUrl = `https://raw.githubusercontent.com/GARajab/testNOPSNonNETLIFY/main/pkgs/Store.pkg`;
            this.addLog(`🌐 Fetching from GitHub: ${pkgUrl}`);

            return new Promise((resolve, reject) => {
                const req = https.request(pkgUrl, { method: 'HEAD' }, (res) => {
                    if (res.statusCode === 200) {
                        const contentLength = res.headers['content-length'];
                        if (contentLength) {
                            resolve({
                                url: pkgUrl,
                                size: parseInt(contentLength),
                                exists: true
                            });
                        } else {
                            reject(new Error('Content-Length not found'));
                        }
                    } else if (res.statusCode === 404) {
                        resolve({
                            url: pkgUrl,
                            size: 0,
                            exists: false
                        });
                    } else {
                        reject(new Error(`HTTP ${res.statusCode}: ${res.statusMessage}`));
                    }
                });

                req.on('error', reject);
                req.setTimeout(10000, () => {
                    req.destroy();
                    reject(new Error('Timeout connecting to GitHub'));
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
            this.addLog("🔍 Scanning GitHub repository for PKG files...");

            // GitHub API to list files in pkgs folder
            const apiUrl = `https://api.github.com/repos/GARajab/testNOPSNonNETLIFY/contents/pkgs`;

            const response = await fetch(apiUrl);
            if (!response.ok) {
                throw new Error(`GitHub API error: ${response.status}`);
            }

            const files = await response.json();
            const pkgList = [];

            for (const file of files) {
                if (file.name.toLowerCase().endsWith('.pkg')) {
                    try {
                        // Get file info from GitHub
                        const pkgInfo = await this.fetchFromGitHub(file.name);

                        if (pkgInfo.exists) {
                            // Extract basic info from PKG metadata
                            const basicInfo = await this.extractBasicPkgInfoFromUrl(pkgInfo.url);

                            pkgList.push({
                                filename: file.name,
                                size: pkgInfo.size,
                                sizeMB: (pkgInfo.size / (1024 * 1024)).toFixed(2),
                                url: pkgInfo.url,
                                title: basicInfo.title || file.name.replace('.pkg', ''),
                                category: basicInfo.category || 'gd',
                                contentId: basicInfo.contentId || 'UNKNOWN',
                                titleId: basicInfo.titleId || 'UNKNOWN',
                                downloadUrl: pkgInfo.url
                            });
                        }
                    } catch (err) {
                        this.addLog(`⚠️ Skipping ${file.name}: ${err.message}`);
                    }
                }
            }

            return pkgList.sort((a, b) => a.title.localeCompare(b.title));
        } catch (error) {
            this.addLog(`❌ Error scanning GitHub: ${error.message}`);

            // Fallback: Try to get from local cache if GitHub fails
            return this.getCachedPkgList();
        }
    }

    async extractBasicPkgInfoFromUrl(pkgUrl) {
        try {
            // Download first 1MB to extract basic info
            const response = await fetch(pkgUrl, {
                headers: { 'Range': 'bytes=0-1048575' }
            });

            if (!response.ok) {
                return this.getFallbackInfo(pkgUrl);
            }

            const buffer = await response.arrayBuffer();
            const data = Buffer.from(buffer);

            const info = {
                title: '',
                category: 'gd',
                contentId: 'UNKNOWN',
                titleId: 'UNKNOWN'
            };

            // Look for param.sfo in the downloaded chunk
            for (let i = 0; i < data.length - 4; i++) {
                if (data[i] === 0x00 && data[i + 1] === 0x50 &&
                    data[i + 2] === 0x53 && data[i + 3] === 0x46) {

                    const sfoOffset = i;
                    let offset = sfoOffset + 8;

                    const keyTableStart = data.readUInt32LE(offset); offset += 4;
                    const dataTableStart = data.readUInt32LE(offset); offset += 4;
                    const entryCount = data.readUInt32LE(offset); offset += 4;

                    for (let j = 0; j < entryCount; j++) {
                        const entryOffset = sfoOffset + 20 + (j * 16);
                        if (entryOffset + 16 > data.length) break;

                        const keyOffset = data.readUInt16LE(entryOffset);
                        const dataFormat = data.readUInt16LE(entryOffset + 2);
                        const dataLength = data.readUInt32LE(entryOffset + 4);
                        const dataOffset = data.readUInt32LE(entryOffset + 12);

                        // Read key name
                        const keyPos = sfoOffset + keyTableStart + keyOffset;
                        let keyName = "";
                        for (let k = 0; k < 50; k++) {
                            if (keyPos + k >= data.length) break;
                            const charCode = data[keyPos + k];
                            if (charCode === 0) break;
                            keyName += String.fromCharCode(charCode);
                        }

                        // Read data value
                        if (dataFormat === 0x0204 && dataLength > 0 && dataLength < 1000) {
                            const dataPos = sfoOffset + dataTableStart + dataOffset;
                            let value = "";

                            for (let k = 0; k < dataLength; k++) {
                                if (dataPos + k >= data.length) break;
                                const charCode = data[dataPos + k];
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
            this.addLog(`⚠️ Could not extract PKG info: ${error.message}`);
            return this.getFallbackInfo(pkgUrl);
        }
    }

    getFallbackInfo(pkgUrl) {
        const filename = path.basename(pkgUrl);
        return {
            title: filename.replace('.pkg', ''),
            category: 'gd',
            contentId: 'UNKNOWN',
            titleId: 'UNKNOWN'
        };
    }

    async extractIconFromUrl(pkgUrl) {
        try {
            // Download first 2MB to find icon
            const response = await fetch(pkgUrl, {
                headers: { 'Range': 'bytes=0-2097151' }
            });

            if (!response.ok) {
                return null;
            }

            const buffer = await response.arrayBuffer();
            const pkgBuffer = Buffer.from(buffer);

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
                if (offset + 32 > pkgBuffer.length) break;

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
                return null;
            }

            // Check if icon is within downloaded range
            if (iconOffset + iconSize > pkgBuffer.length) {
                // Need to download more data for the icon
                const iconResponse = await fetch(pkgUrl, {
                    headers: { 'Range': `bytes=${iconOffset}-${iconOffset + iconSize - 1}` }
                });

                if (!iconResponse.ok) {
                    return null;
                }

                const iconBuffer = await iconResponse.arrayBuffer();
                const iconData = Buffer.from(iconBuffer);

                const isPNG = iconData[0] === 0x89 && iconData[1] === 0x50 &&
                    iconData[2] === 0x4E && iconData[3] === 0x47;
                const isJPEG = iconData[0] === 0xFF && iconData[1] === 0xD8;

                if (isPNG || isJPEG) {
                    return {
                        data: iconData,
                        size: iconSize,
                        type: isPNG ? 'png' : 'jpeg'
                    };
                }
            } else {
                // Icon is within already downloaded data
                const iconData = pkgBuffer.slice(iconOffset, iconOffset + iconSize);

                const isPNG = iconData[0] === 0x89 && iconData[1] === 0x50 &&
                    iconData[2] === 0x4E && iconData[3] === 0x47;
                const isJPEG = iconData[0] === 0xFF && iconData[1] === 0xD8;

                if (isPNG || isJPEG) {
                    return {
                        data: iconData,
                        size: iconSize,
                        type: isPNG ? 'png' : 'jpeg'
                    };
                }
            }

            return null;

        } catch (error) {
            this.addLog(`⚠️ Error extracting icon: ${error.message}`);
            return null;
        }
    }

    async getCachedPkgList() {
        try {
            const cacheFile = path.join(this.cacheFolder, 'pkg_cache.json');
            if (fs.existsSync(cacheFile)) {
                const data = fs.readFileSync(cacheFile, 'utf8');
                return JSON.parse(data);
            }
        } catch (error) {
            // Ignore cache errors
        }
        return [];
    }

    async savePkgCache(pkgList) {
        try {
            const cacheFile = path.join(this.cacheFolder, 'pkg_cache.json');
            fs.writeFileSync(cacheFile, JSON.stringify(pkgList, null, 2));
        } catch (error) {
            // Ignore cache save errors
        }
    }

    async install(pkgName) {
        this.installationLog = [];
        this.addLog("🎮 DUAL REQUEST INSTALLER");
        this.addLog("==================================================");

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
        this.addLog(`📋 Version: ${this.pkgInfo.version}`);

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

    async extractFullPkgInfoFromUrl(pkgUrl) {
        try {
            // Download first 2MB for param.sfo extraction
            const response = await fetch(pkgUrl, {
                headers: { 'Range': 'bytes=0-2097151' }
            });

            if (!response.ok) {
                return this.generateFallbackInfo(pkgUrl);
            }

            const buffer = await response.arrayBuffer();
            const pkgBuffer = Buffer.from(buffer);

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
                filename: path.basename(pkgUrl),
                filesize: this.pkgSize || 0,
                filesizeMB: this.pkgSize ? (this.pkgSize / (1024 * 1024)).toFixed(2) : '0'
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
                return this.generateFallbackInfo(pkgUrl);
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
                }
            }

            // Determine content type
            if (info.category) {
                info.contentType = this.getContentType(info.category);
            }

            return info;

        } catch (error) {
            this.addLog(`❌ Error extracting PKG info: ${error.message}`);
            return this.generateFallbackInfo(pkgUrl);
        }
    }

    generateFallbackInfo(pkgUrl) {
        const filename = path.basename(pkgUrl);
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
            filesize: this.pkgSize || 0,
            filesizeMB: this.pkgSize ? (this.pkgSize / (1024 * 1024)).toFixed(2) : '0'
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

    sendMetadata(pkgUrl) {
        if (!this.callbackSocket) {
            this.addLog("❌ No callback socket");
            return;
        }
        try {
            const contentId = this.pkgInfo.contentId;
            const bgftType = this.pkgInfo.category;
            const title = this.pkgInfo.title;

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
            this.addLog(`   Source: GitHub`);
        } catch (err) {
            this.addLog(`❌ Metadata error: ${err.message}`);
        }
    }

    async streamFileFromGitHub(pkgUrl) {
        if (!this.callbackSocket) {
            this.addLog("❌ No callback socket for streaming");
            return;
        }

        this.addLog(`📥 Downloading from GitHub: ${pkgUrl}`);
        return new Promise((resolve) => {
            https.get(pkgUrl, (res) => {
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
app.get('/api/pkgs', async (req, res) => {
    try {
        const pkgs = await installer.scanPkgFolder();
        res.json({
            success: true,
            pkgs: pkgs,
            count: pkgs.length,
            source: 'GitHub',
            repo: installer.githubRepo
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            message: error.message,
            pkgs: []
        });
    }
});

app.get('/api/pkgs/:pkgName/info', async (req, res) => {
    try {
        const pkgName = req.params.pkgName;
        const pkgUrl = `https://raw.githubusercontent.com/${installer.githubRepo}/main/pkgs/${encodeURIComponent(pkgName)}`;

        // Check if file exists
        const pkgInfo = await installer.fetchFromGitHub(pkgName);
        if (!pkgInfo.exists) {
            return res.status(404).json({
                success: false,
                message: 'PKG file not found on GitHub'
            });
        }

        const info = await installer.extractFullPkgInfoFromUrl(pkgUrl);
        const icon = await installer.extractIconFromUrl(pkgUrl);

        const response = {
            success: true,
            info: info,
            hasIcon: !!icon,
            iconSize: icon ? icon.size : 0,
            iconType: icon ? icon.type : null,
            source: 'GitHub',
            url: pkgUrl
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
        installer.addLog("Starting installation from GitHub...");
        const success = await installer.install(pkgName);
        res.json({
            success,
            message: success ? "Installation completed" : "Installation failed",
            log: installer.installationLog,
            source: 'GitHub'
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
        currentPkg: installer.pkgName,
        source: 'GitHub'
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
                    .github { color: blue; }
                </style>
                </head>
                <body>
                    <h1>🎮 PS4 Package Installer</h1>
                    <p class="github">📂 Loading PKG files from GitHub...</p>
                    <p>If you see this, index.html is not found in root directory.</p>
                </body>
            </html>
        `);
    }
});

// Serve static files from root
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
    console.log(`📂 Loading PKG files from GitHub: ${installer.githubRepo}`);
    console.log(`🔗 GitHub URL: https://github.com/${installer.githubRepo}`);
    console.log(`\n📋 API Endpoints:`);
    console.log(`   GET  /api/pkgs - List PKG files from GitHub`);
    console.log(`   GET  /api/pkgs/{name}/info - Get PKG info`);
    console.log(`   POST /api/install - Install PKG from GitHub`);
    console.log(`   GET  /api/status - Check installation status`);
    console.log(`   POST /api/cleanup - Cleanup connections`);
});