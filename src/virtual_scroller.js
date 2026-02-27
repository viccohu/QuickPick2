class VirtualScroller {
    constructor(options = {}) {
        this.container = options.container;
        this.itemWidth = options.itemWidth || 120;
        this.itemHeight = options.itemHeight || 100;
        this.buffer = options.buffer || 5;
        this.items = [];
        this.visibleItems = new Map();
        this.scrollTop = 0;
        this.scrollLeft = 0;
        
        this.onRenderItem = options.onRenderItem || (() => {});
        this.onRecycleItem = options.onRecycleItem || (() => {});
        
        if (this.container) {
            this.init();
        }
    }
    
    init() {
        this.wrapper = document.createElement('div');
        this.wrapper.style.cssText = `
            position: relative;
            min-width: 100%;
            min-height: 100%;
        `;
        
        this.container.style.contain = 'strict';
        this.container.appendChild(this.wrapper);
        
        this.container.addEventListener('scroll', this.onScroll.bind(this), { passive: true });
        
        this.resizeObserver = new ResizeObserver(this.onResize.bind(this));
        this.resizeObserver.observe(this.container);
        
        this.calculateDimensions();
    }
    
    calculateDimensions() {
        const rect = this.container.getBoundingClientRect();
        this.viewportWidth = rect.width;
        this.viewportHeight = rect.height;
        
        this.itemsPerRow = Math.floor(this.viewportWidth / this.itemWidth);
        this.visibleRows = Math.ceil(this.viewportHeight / this.itemHeight) + this.buffer * 2;
        this.totalVisibleItems = this.itemsPerRow * this.visibleRows;
    }
    
    setItems(items) {
        this.items = items;
        this.updateTotalSize();
        this.render();
    }
    
    updateTotalSize() {
        const totalItems = this.items.length;
        const totalRows = Math.ceil(totalItems / this.itemsPerRow);
        const totalHeight = totalRows * this.itemHeight;
        const totalWidth = this.itemsPerRow * this.itemWidth;
        
        this.wrapper.style.height = `${totalHeight}px`;
        this.wrapper.style.width = `${totalWidth}px`;
    }
    
    onScroll() {
        this.scrollTop = this.container.scrollTop;
        this.scrollLeft = this.container.scrollLeft;
        this.render();
    }
    
    onResize() {
        this.calculateDimensions();
        this.updateTotalSize();
        this.render();
    }
    
    render() {
        if (!this.items.length) return;
        
        const startRow = Math.max(0, Math.floor(this.scrollTop / this.itemHeight) - this.buffer);
        const endRow = Math.min(
            Math.ceil(this.items.length / this.itemsPerRow),
            startRow + this.visibleRows
        );
        
        const startIndex = startRow * this.itemsPerRow;
        const endIndex = Math.min(endRow * this.itemsPerRow, this.items.length);
        
        const newVisibleItems = new Map();
        
        for (let i = startIndex; i < endIndex; i++) {
            const item = this.items[i];
            if (!item) continue;
            
            const element = this.getOrCreateItem(i, item);
            newVisibleItems.set(i, element);
        }
        
        this.visibleItems.forEach((element, index) => {
            if (!newVisibleItems.has(index)) {
                this.recycleItem(index, element);
            }
        });
        
        this.visibleItems = newVisibleItems;
    }
    
    getOrCreateItem(index, item) {
        if (this.visibleItems.has(index)) {
            return this.visibleItems.get(index);
        }
        
        const row = Math.floor(index / this.itemsPerRow);
        const col = index % this.itemsPerRow;
        
        const x = col * this.itemWidth;
        const y = row * this.itemHeight;
        
        const element = document.createElement('div');
        element.style.cssText = `
            position: absolute;
            left: ${x}px;
            top: ${y}px;
            width: ${this.itemWidth}px;
            height: ${this.itemHeight}px;
        `;
        
        this.wrapper.appendChild(element);
        this.onRenderItem(element, item, index);
        
        return element;
    }
    
    recycleItem(index, element) {
        this.onRecycleItem(element, index);
        if (element.parentNode) {
            element.parentNode.removeChild(element);
        }
    }
    
    scrollToIndex(index) {
        const row = Math.floor(index / this.itemsPerRow);
        const col = index % this.itemsPerRow;
        
        const targetTop = row * this.itemHeight;
        const targetLeft = col * this.itemWidth;
        
        this.container.scrollTo({
            top: targetTop - this.viewportHeight / 2 + this.itemHeight / 2,
            left: targetLeft - this.viewportWidth / 2 + this.itemWidth / 2,
            behavior: 'smooth'
        });
    }
    
    scrollToTop() {
        this.container.scrollTo({
            top: 0,
            behavior: 'smooth'
        });
    }
    
    destroy() {
        if (this.resizeObserver) {
            this.resizeObserver.disconnect();
        }
        
        this.visibleItems.forEach((element, index) => {
            this.recycleItem(index, element);
        });
        
        this.visibleItems.clear();
        
        if (this.wrapper && this.wrapper.parentNode) {
            this.wrapper.parentNode.removeChild(this.wrapper);
        }
    }
    
    updateItem(index, item) {
        if (this.visibleItems.has(index)) {
            const element = this.visibleItems.get(index);
            this.onRenderItem(element, item, index);
        }
    }
    
    getItemElement(index) {
        return this.visibleItems.get(index);
    }
    
    getVisibleRange() {
        const startRow = Math.max(0, Math.floor(this.scrollTop / this.itemHeight) - this.buffer);
        const endRow = Math.min(
            Math.ceil(this.items.length / this.itemsPerRow),
            startRow + this.visibleRows
        );
        
        return {
            start: startRow * this.itemsPerRow,
            end: Math.min(endRow * this.itemsPerRow, this.items.length)
        };
    }
    
    isItemVisible(index) {
        const range = this.getVisibleRange();
        return index >= range.start && index < range.end;
    }
}

module.exports = VirtualScroller;
