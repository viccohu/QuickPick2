const { contextBridge, ipcRenderer } = require('electron');

// 暴露API给渲染进程
contextBridge.exposeInMainWorld('electronAPI', {
  // 文件选择对话框
  openDirectoryDialog: (options) => ipcRenderer.invoke('open-directory-dialog', options),
  saveDialog: (options) => ipcRenderer.invoke('save-dialog', options),
  
  // 消息框
  showMessageBox: (options) => ipcRenderer.invoke('show-message-box', options),
  
  // 窗口控制
  window: {
    minimize: () => ipcRenderer.invoke('window:minimize'),
    maximize: () => ipcRenderer.invoke('window:maximize'),
    close: () => ipcRenderer.invoke('window:close')
  },
  
  // 文件系统操作
  fs: {
    readdir: (dirPath) => ipcRenderer.invoke('fs:readdir', dirPath),
    stat: (filePath) => ipcRenderer.invoke('fs:stat', filePath),
    copyFile: (source, target) => ipcRenderer.invoke('fs:copyFile', { source, target }),
    existsSync: (path) => ipcRenderer.invoke('fs:existsSync', path),
    mkdirSync: (path, options) => ipcRenderer.invoke('fs:mkdirSync', { path, options })
  },
  
  // 图片操作
  image: {
    readRating: (filePath) => ipcRenderer.invoke('image:read-rating', filePath),
    saveRating: (filePath, rating) => ipcRenderer.invoke('image:save-rating', { filePath, rating }),
    readMetadata: (filePath) => ipcRenderer.invoke('image:read-metadata', filePath)
  }
});