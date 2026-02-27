class LRUCache {
    constructor(maxSize = 100 * 1024 * 1024) {
        this.maxSize = maxSize;
        this.currentSize = 0;
        this.cache = new Map();
        this.accessOrder = [];
        
        this.hits = 0;
        this.misses = 0;
    }
    
    get(key) {
        if (this.cache.has(key)) {
            this.hits++;
            this.updateAccessOrder(key);
            const item = this.cache.get(key);
            item.lastAccess = Date.now();
            return item.value;
        }
        this.misses++;
        return undefined;
    }
    
    set(key, value, size = 0) {
        if (this.cache.has(key)) {
            const existingItem = this.cache.get(key);
            this.currentSize -= existingItem.size;
            this.currentSize += size;
            existingItem.value = value;
            existingItem.size = size;
            existingItem.lastAccess = Date.now();
            this.updateAccessOrder(key);
        } else {
            while (this.currentSize + size > this.maxSize && this.accessOrder.length > 0) {
                this.evictLRU();
            }
            
            const item = {
                value,
                size,
                lastAccess: Date.now(),
                createdAt: Date.now()
            };
            
            this.cache.set(key, item);
            this.accessOrder.push(key);
            this.currentSize += size;
        }
    }
    
    has(key) {
        return this.cache.has(key);
    }
    
    delete(key) {
        if (this.cache.has(key)) {
            const item = this.cache.get(key);
            this.currentSize -= item.size;
            this.cache.delete(key);
            const index = this.accessOrder.indexOf(key);
            if (index > -1) {
                this.accessOrder.splice(index, 1);
            }
            return true;
        }
        return false;
    }
    
    clear() {
        this.cache.clear();
        this.accessOrder = [];
        this.currentSize = 0;
    }
    
    updateAccessOrder(key) {
        const index = this.accessOrder.indexOf(key);
        if (index > -1) {
            this.accessOrder.splice(index, 1);
            this.accessOrder.push(key);
        }
    }
    
    evictLRU() {
        if (this.accessOrder.length === 0) return;
        
        const lruKey = this.accessOrder.shift();
        if (this.cache.has(lruKey)) {
            const item = this.cache.get(lruKey);
            this.currentSize -= item.size;
            this.cache.delete(lruKey);
        }
    }
    
    getStats() {
        return {
            size: this.currentSize,
            maxSize: this.maxSize,
            items: this.cache.size,
            hits: this.hits,
            misses: this.misses,
            hitRate: this.hits + this.misses > 0 ? this.hits / (this.hits + this.misses) : 0
        };
    }
    
    prune(maxAge = 30 * 60 * 1000) {
        const now = Date.now();
        const keysToDelete = [];
        
        this.cache.forEach((item, key) => {
            if (now - item.lastAccess > maxAge) {
                keysToDelete.push(key);
            }
        });
        
        keysToDelete.forEach(key => this.delete(key));
        
        return keysToDelete.length;
    }
}

class ThumbnailCache {
    constructor(maxSize = 200 * 1024 * 1024) {
        this.cache = new LRUCache(maxSize);
        this.pending = new Map();
        this.priority = new Map();
    }
    
    async get(path, generator) {
        if (this.cache.has(path)) {
            return this.cache.get(path);
        }
        
        if (this.pending.has(path)) {
            return this.pending.get(path);
        }
        
        const promise = this.generateThumbnail(path, generator);
        this.pending.set(path, promise);
        
        try {
            const result = await promise;
            return result;
        } finally {
            this.pending.delete(path);
        }
    }
    
    async generateThumbnail(path, generator) {
        try {
            const thumbnail = await generator(path);
            if (thumbnail) {
                const size = thumbnail.length || thumbnail.byteLength || 0;
                this.cache.set(path, thumbnail, size);
            }
            return thumbnail;
        } catch (e) {
            console.error(`Failed to generate thumbnail for ${path}:`, e);
            return null;
        }
    }
    
    set(path, thumbnail) {
        const size = thumbnail.length || thumbnail.byteLength || 0;
        this.cache.set(path, thumbnail, size);
    }
    
    has(path) {
        return this.cache.has(path);
    }
    
    delete(path) {
        return this.cache.delete(path);
    }
    
    clear() {
        this.cache.clear();
        this.pending.clear();
    }
    
    getStats() {
        return this.cache.getStats();
    }
    
    setPriority(path, priority) {
        this.priority.set(path, priority);
    }
    
    prune(maxAge = 30 * 60 * 1000) {
        return this.cache.prune(maxAge);
    }
}

class PreviewCache {
    constructor(maxSize = 500 * 1024 * 1024) {
        this.cache = new LRUCache(maxSize);
        this.pending = new Map();
    }
    
    async get(path, generator) {
        if (this.cache.has(path)) {
            return this.cache.get(path);
        }
        
        if (this.pending.has(path)) {
            return this.pending.get(path);
        }
        
        const promise = this.generatePreview(path, generator);
        this.pending.set(path, promise);
        
        try {
            const result = await promise;
            return result;
        } finally {
            this.pending.delete(path);
        }
    }
    
    async generatePreview(path, generator) {
        try {
            const preview = await generator(path);
            if (preview) {
                const size = preview.length || preview.byteLength || 0;
                this.cache.set(path, preview, size);
            }
            return preview;
        } catch (e) {
            console.error(`Failed to generate preview for ${path}:`, e);
            return null;
        }
    }
    
    set(path, preview) {
        const size = preview.length || preview.byteLength || 0;
        this.cache.set(path, preview, size);
    }
    
    has(path) {
        return this.cache.has(path);
    }
    
    delete(path) {
        return this.cache.delete(path);
    }
    
    clear() {
        this.cache.clear();
        this.pending.clear();
    }
    
    getStats() {
        return this.cache.getStats();
    }
    
    prune(maxAge = 10 * 60 * 1000) {
        return this.cache.prune(maxAge);
    }
}

class RatingCache {
    constructor() {
        this.cache = new Map();
        this.pending = new Map();
    }
    
    get(path) {
        return this.cache.get(path);
    }
    
    async getOrFetch(path, fetcher) {
        if (this.cache.has(path)) {
            return this.cache.get(path);
        }
        
        if (this.pending.has(path)) {
            return this.pending.get(path);
        }
        
        const promise = fetcher(path);
        this.pending.set(path, promise);
        
        try {
            const rating = await promise;
            this.cache.set(path, rating);
            return rating;
        } finally {
            this.pending.delete(path);
        }
    }
    
    set(path, rating) {
        this.cache.set(path, rating);
    }
    
    has(path) {
        return this.cache.has(path);
    }
    
    delete(path) {
        return this.cache.delete(path);
    }
    
    clear() {
        this.cache.clear();
        this.pending.clear();
    }
    
    getStats() {
        return {
            items: this.cache.size,
            pending: this.pending.size
        };
    }
    
    export() {
        const data = {};
        this.cache.forEach((rating, path) => {
            data[path] = rating;
        });
        return data;
    }
    
    import(data) {
        Object.entries(data).forEach(([path, rating]) => {
            this.cache.set(path, rating);
        });
    }
}

class CacheManager {
    constructor() {
        this.thumbnails = new ThumbnailCache(200 * 1024 * 1024);
        this.previews = new PreviewCache(500 * 1024 * 1024);
        this.ratings = new RatingCache();
        
        this.pruneInterval = setInterval(() => {
            this.prune();
        }, 5 * 60 * 1000);
    }
    
    prune() {
        const thumbnailPruned = this.thumbnails.prune();
        const previewPruned = this.previews.prune();
        
        if (thumbnailPruned > 0 || previewPruned > 0) {
            console.log(`[Cache] Pruned ${thumbnailPruned} thumbnails, ${previewPruned} previews`);
        }
    }
    
    getStats() {
        return {
            thumbnails: this.thumbnails.getStats(),
            previews: this.previews.getStats(),
            ratings: this.ratings.getStats()
        };
    }
    
    clear() {
        this.thumbnails.clear();
        this.previews.clear();
        this.ratings.clear();
    }
    
    destroy() {
        if (this.pruneInterval) {
            clearInterval(this.pruneInterval);
        }
        this.clear();
    }
}

module.exports = {
    LRUCache,
    ThumbnailCache,
    PreviewCache,
    RatingCache,
    CacheManager
};
