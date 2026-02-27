const path = require('path');

let nativeModule = null;

try {
    nativeModule = require('../native/build/Release/quickpick_native.node');
    console.log('[Native] C++ native module loaded successfully');
} catch (e) {
    console.warn('[Native] Failed to load C++ native module, using fallback:', e.message);
}

class NativeBridge {
    constructor() {
        this.isNativeAvailable = !!nativeModule;
    }
    
    async generateThumbnails(imagePaths, options = {}) {
        const defaultOptions = {
            maxWidth: 120,
            maxHeight: 80,
            quality: 85
        };
        
        const opts = { ...defaultOptions, ...options };
        
        if (this.isNativeAvailable && nativeModule.generateThumbnails) {
            try {
                const results = await nativeModule.generateThumbnails(imagePaths, opts);
                return this.processThumbnailResults(results);
            } catch (e) {
                console.error('[Native] Thumbnail generation failed:', e);
            }
        }
        
        return this.fallbackGenerateThumbnails(imagePaths, opts);
    }
    
    async readExifRatings(imagePaths) {
        if (this.isNativeAvailable && nativeModule.readExifRatings) {
            try {
                return await nativeModule.readExifRatings(imagePaths);
            } catch (e) {
                console.error('[Native] EXIF reading failed:', e);
            }
        }
        
        return this.fallbackReadExifRatings(imagePaths);
    }
    
    async scanFiles(directories, extensions = []) {
        if (this.isNativeAvailable && nativeModule.scanFiles) {
            try {
                const result = await nativeModule.scanFiles(directories, extensions);
                return result.files;
            } catch (e) {
                console.error('[Native] File scanning failed:', e);
            }
        }
        
        return this.fallbackScanFiles(directories, extensions);
    }
    
    processThumbnailResults(results) {
        const processed = {};
        
        for (let i = 0; i < results.length; i++) {
            const item = results[i];
            if (item.success && item.data) {
                processed[item.path] = {
                    data: item.data,
                    width: item.width,
                    height: item.height
                };
            }
        }
        
        return processed;
    }
    
    async fallbackGenerateThumbnails(imagePaths, options) {
        const results = {};
        const sharp = require('sharp');
        
        const batchSize = 10;
        for (let i = 0; i < imagePaths.length; i += batchSize) {
            const batch = imagePaths.slice(i, i + batchSize);
            
            const promises = batch.map(async (imagePath) => {
                try {
                    const buffer = await sharp(imagePath)
                        .resize(options.maxWidth, options.maxHeight, {
                            fit: 'inside',
                            withoutEnlargement: true
                        })
                        .jpeg({ quality: options.quality })
                        .toBuffer();
                    
                    return {
                        path: imagePath,
                        data: buffer,
                        success: true
                    };
                } catch (e) {
                    return {
                        path: imagePath,
                        error: e.message,
                        success: false
                    };
                }
            });
            
            const batchResults = await Promise.all(promises);
            
            batchResults.forEach(result => {
                if (result.success) {
                    results[result.path] = {
                        data: result.data,
                        width: options.maxWidth,
                        height: options.maxHeight
                    };
                }
            });
        }
        
        return results;
    }
    
    async fallbackReadExifRatings(imagePaths) {
        const results = {};
        const exiftool = require('exiftool-vendored').exiftool;
        
        const batchSize = 20;
        for (let i = 0; i < imagePaths.length; i += batchSize) {
            const batch = imagePaths.slice(i, i + batchSize);
            
            const promises = batch.map(async (imagePath) => {
                try {
                    const tags = await exiftool.read(imagePath);
                    const rating = tags.Rating || tags['XMP:Rating'] || 0;
                    return {
                        path: imagePath,
                        rating: parseInt(rating) || 0,
                        success: true
                    };
                } catch (e) {
                    return {
                        path: imagePath,
                        rating: 0,
                        error: e.message,
                        success: false
                    };
                }
            });
            
            const batchResults = await Promise.all(promises);
            
            batchResults.forEach(result => {
                results[result.path] = {
                    rating: result.rating,
                    success: result.success
                };
            });
        }
        
        return results;
    }
    
    async fallbackScanFiles(directories, extensions) {
        const fs = require('fs');
        const results = [];
        
        for (const dir of directories) {
            try {
                const files = fs.readdirSync(dir);
                
                files.forEach(file => {
                    const filePath = path.join(dir, file);
                    const stat = fs.statSync(filePath);
                    const ext = path.extname(file).toLowerCase();
                    
                    if (!stat.isDirectory()) {
                        if (extensions.length === 0 || extensions.includes(ext)) {
                            results.push({
                                path: filePath,
                                name: file,
                                extension: ext,
                                isDirectory: false,
                                size: stat.size
                            });
                        }
                    }
                });
            } catch (e) {
                console.error(`Error scanning directory ${dir}:`, e);
            }
        }
        
        return results;
    }
    
    getStatus() {
        return {
            nativeAvailable: this.isNativeAvailable,
            modules: this.isNativeAvailable ? Object.keys(nativeModule) : []
        };
    }
}

module.exports = new NativeBridge();
