const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  openDirectoryDialog: (options) => ipcRenderer.invoke('open-directory-dialog', options),
  saveDialog: (options) => ipcRenderer.invoke('save-dialog', options),
  
  showMessageBox: (options) => ipcRenderer.invoke('show-message-box', options),
  
  window: {
    minimize: () => ipcRenderer.invoke('window:minimize'),
    maximize: () => ipcRenderer.invoke('window:maximize'),
    close: () => ipcRenderer.invoke('window:close')
  },
  
  fs: {
    readdir: (dirPath) => ipcRenderer.invoke('fs:readdir', dirPath),
    stat: (filePath) => ipcRenderer.invoke('fs:stat', filePath),
    copyFile: (source, target) => ipcRenderer.invoke('fs:copyFile', { source, target }),
    existsSync: (path) => ipcRenderer.invoke('fs:existsSync', path),
    mkdirSync: (path, options) => ipcRenderer.invoke('fs:mkdirSync', { path, options }),
    deleteFile: (filePath) => ipcRenderer.invoke('fs:deleteFile', filePath)
  },
  
  image: {
    readRating: (filePath) => ipcRenderer.invoke('image:read-rating', filePath),
    saveRating: (filePath, rating) => ipcRenderer.invoke('image:save-rating', { filePath, rating }),
    saveRatingAsync: (filePath, rating) => ipcRenderer.invoke('image:save-rating-async', { filePath, rating }),
    readMetadata: (filePath) => ipcRenderer.invoke('image:read-metadata', filePath),
    getThumbnail: (filePath, maxSize) => ipcRenderer.invoke('image:get-thumbnail', { filePath, maxSize }),
    getPreview: (filePath, previewSize) => ipcRenderer.invoke('image:get-preview', { filePath, previewSize }),
    clearCache: () => ipcRenderer.invoke('image:clear-cache'),
    onPreviewUpdated: (callback) => {
      const listener = (event, data) => callback(data);
      ipcRenderer.on('image:preview-updated', listener);
      return () => ipcRenderer.removeListener('image:preview-updated', listener);
    }
  },
  
  native: {
    getStatus: () => ipcRenderer.invoke('native:get-status'),
    generateThumbnails: (paths, options) => ipcRenderer.invoke('native:generate-thumbnails', { paths, options }),
    readExifRatings: (paths) => ipcRenderer.invoke('native:read-exif-ratings', { paths }),
    scanFiles: (directories, extensions) => ipcRenderer.invoke('native:scan-files', { directories, extensions })
  },
  
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    getOne: (key) => ipcRenderer.invoke('settings:get-one', key),
    set: (settings) => ipcRenderer.invoke('settings:set', settings),
    setOne: (key, value) => ipcRenderer.invoke('settings:set-one', { key, value }),
    reset: () => ipcRenderer.invoke('settings:reset')
  }
});