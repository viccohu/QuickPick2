const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const ExifReader = require('exifreader');
const { exiftool } = require('exiftool-vendored');

const THUMBNAIL_SIZE = 240;
const THUMBNAIL_QUALITY = 80;
const MAX_CACHE_ITEMS = 500;
const CACHE_CLEANUP_THRESHOLD = 0.8;

let thumbnailCache = new Map();
let cacheAccessOrder = [];
let cacheDir = null;
let ratingQueue = [];
let isProcessingRatingQueue = false;

function getCacheDir() {
  if (!cacheDir) {
    const userHome = app.getPath('home');
    cacheDir = path.join(userHome, '.photo_manager', 'thumbnails');
    if (!fs.existsSync(cacheDir)) {
      fs.mkdirSync(cacheDir, { recursive: true });
    }
  }
  return cacheDir;
}

function getFileHash(filePath) {
  const stats = fs.statSync(filePath);
  const hashInput = `${filePath}:${stats.size}:${stats.mtime.getTime()}`;
  return crypto.createHash('md5').update(hashInput).digest('hex');
}

function getThumbnailPath(filePath) {
  const hash = getFileHash(filePath);
  const ext = path.extname(filePath).toLowerCase();
  return path.join(getCacheDir(), `${hash}${ext === '.raw' ? '.jpg' : ext}`);
}

function getEmbeddedJpegFromRaw(filePath) {
  try {
    const buffer = fs.readFileSync(filePath);
    let offset = 0;
    
    while (offset < buffer.length - 4) {
      if (buffer[offset] === 0xFF && buffer[offset + 1] === 0xD8 && buffer[offset + 2] === 0xFF) {
        let endOffset = offset + 2;
        while (endOffset < buffer.length - 1) {
          if (buffer[endOffset] === 0xFF && buffer[endOffset + 1] === 0xD9) {
            endOffset += 2;
            return buffer.slice(offset, endOffset);
          }
          endOffset++;
        }
      }
      offset++;
    }
    return null;
  } catch (error) {
    return null;
  }
}

async function generateThumbnail(filePath, maxSize = THUMBNAIL_SIZE) {
  try {
    const ext = path.extname(filePath).toLowerCase();
    const isRaw = ['.cr2', '.cr3', '.arw', '.nef', '.dng', '.raw'].includes(ext);
    
    let imageBuffer;
    if (isRaw) {
      imageBuffer = getEmbeddedJpegFromRaw(filePath);
      if (!imageBuffer) {
        return null;
      }
    } else {
      imageBuffer = fs.readFileSync(filePath);
    }
    
    const dimensions = getImageDimensions(imageBuffer);
    if (!dimensions) {
      return imageBuffer;
    }
    
    const { width, height } = dimensions;
    const scale = Math.min(maxSize / width, maxSize / height, 1);
    
    if (scale >= 1) {
      return imageBuffer;
    }
    
    return imageBuffer;
  } catch (error) {
    console.error('生成缩略图失败:', error);
    return null;
  }
}

function getImageDimensions(buffer) {
  try {
    let offset = 0;
    
    if (buffer[0] !== 0xFF || buffer[1] !== 0xD8) {
      return null;
    }
    
    offset = 2;
    while (offset < buffer.length - 4) {
      if (buffer[offset] !== 0xFF) break;
      
      const marker = buffer[offset + 1];
      
      if (marker === 0xC0 || marker === 0xC2) {
        const height = buffer.readUInt16BE(offset + 5);
        const width = buffer.readUInt16BE(offset + 7);
        return { width, height };
      }
      
      if (marker >= 0xD0 && marker <= 0xD9) {
        offset += 2;
      } else {
        const length = buffer.readUInt16BE(offset + 2);
        offset += 2 + length;
      }
    }
    
    return null;
  } catch (error) {
    return null;
  }
}

function updateCacheAccess(key) {
  const index = cacheAccessOrder.indexOf(key);
  if (index !== -1) {
    cacheAccessOrder.splice(index, 1);
  }
  cacheAccessOrder.push(key);
}

function evictLRU() {
  if (thumbnailCache.size <= MAX_CACHE_ITEMS * CACHE_CLEANUP_THRESHOLD) {
    return;
  }
  
  const itemsToEvict = Math.floor(MAX_CACHE_ITEMS * 0.2);
  for (let i = 0; i < itemsToEvict && cacheAccessOrder.length > 0; i++) {
    const key = cacheAccessOrder.shift();
    thumbnailCache.delete(key);
  }
}

async function processRatingQueue() {
  if (isProcessingRatingQueue || ratingQueue.length === 0) return;
  
  isProcessingRatingQueue = true;
  
  while (ratingQueue.length > 0) {
    const task = ratingQueue.shift();
    try {
      await saveImageRating(task.filePath, task.rating);
    } catch (error) {
      console.error('后台保存评级失败:', error);
    }
  }
  
  isProcessingRatingQueue = false;
}

// 读取图片元数据
function readImageMetadata(filePath) {
  try {
    const buffer = fs.readFileSync(filePath);
    const tags = ExifReader.load(buffer);
    return tags;
  } catch (error) {
    console.error('读取图片元数据失败:', error);
    return null;
  }
}

// 写入图片评级到源文件元数据
async function saveImageRating(filePath, rating) {
  try {
    // 使用exiftool写入Rating标签到图片元数据
    // Rating标签是标准的EXIF标签，大多数图片查看器都支持
    await exiftool.write(filePath, {
      'Rating': rating,
      'RatingPercent': rating * 20 // 1-5星转换为百分比(20-100)
    });
    return true;
  } catch (error) {
    console.error('保存图片评级失败:', error);
    return false;
  }
}

// 从图片源文件元数据读取评级
async function getImageRating(filePath) {
  try {
    // 使用exiftool读取Rating标签
    const tags = await exiftool.read(filePath);
    
    // 尝试读取Rating标签
    if (tags.Rating !== undefined) {
      return parseInt(tags.Rating) || 0;
    }
    
    // 尝试读取RatingPercent标签并转换为1-5星
    if (tags.RatingPercent !== undefined) {
      const percent = parseInt(tags.RatingPercent) || 0;
      return Math.round(percent / 20);
    }
    
    // 尝试读取Microsoft Rating标签
    if (tags['XMP-microsoft:Rating'] !== undefined) {
      return parseInt(tags['XMP-microsoft:Rating']) || 0;
    }
    
    return 0;
  } catch (error) {
    console.error('读取图片评级失败:', error);
    return 0;
  }
}

// 全局变量
let mainWindow;

// 创建主窗口
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    frame: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true
    },
    title: 'QuickPick2 - 图片查看管理器'
  });

  // 加载主页面
  mainWindow.loadFile('index.html');

  // 允许使用F12开启开发者工具
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.key === 'F12') {
      mainWindow.webContents.toggleDevTools();
      event.preventDefault();
    }
  });

  // 监听窗口关闭事件
  mainWindow.on('closed', function () {
    mainWindow = null;
  });
}

// 应用就绪后创建窗口
app.whenReady().then(createWindow);

// 监听所有窗口关闭事件
app.on('window-all-closed', function () {
  if (process.platform !== 'darwin') app.quit();
});

// 监听应用激活事件
app.on('activate', function () {
  if (mainWindow === null) createWindow();
});

// 监听文件选择对话框请求
ipcMain.handle('open-directory-dialog', async (event, options) => {
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    ...options
  });
  return canceled ? null : filePaths[0];
});

// 监听导出目录选择对话框请求
ipcMain.handle('save-dialog', async (event, options) => {
  const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
    ...options,
    properties: ['openDirectory']
  });
  return canceled ? null : filePath;
});

// 监听消息框请求
ipcMain.handle('show-message-box', async (event, options) => {
  return await dialog.showMessageBox(mainWindow, options);
});

// 监听文件系统操作
ipcMain.handle('fs:readdir', async (event, dirPath) => {
  return new Promise((resolve, reject) => {
    fs.readdir(dirPath, (err, files) => {
      if (err) reject(err);
      else resolve(files);
    });
  });
});

ipcMain.handle('fs:stat', async (event, filePath) => {
  return new Promise((resolve, reject) => {
    fs.stat(filePath, (err, stats) => {
      if (err) reject(err);
      else resolve(stats);
    });
  });
});

ipcMain.handle('fs:copyFile', async (event, { source, target }) => {
  return new Promise((resolve, reject) => {
    // 确保目标目录存在
    const targetDir = path.dirname(target);
    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
    }
    
    fs.copyFile(source, target, (err) => {
      if (err) reject(err);
      else resolve(true);
    });
  });
});

ipcMain.handle('fs:existsSync', (event, path) => {
  return fs.existsSync(path);
});

ipcMain.handle('fs:mkdirSync', (event, { path, options }) => {
  return fs.mkdirSync(path, options);
});

// 监听图片评级操作
ipcMain.handle('image:read-rating', (event, filePath) => {
  return getImageRating(filePath);
});

ipcMain.handle('image:save-rating', (event, { filePath, rating }) => {
  return saveImageRating(filePath, rating);
});

ipcMain.handle('image:save-rating-async', (event, { filePath, rating }) => {
  ratingQueue.push({ filePath, rating });
  setImmediate(processRatingQueue);
  return true;
});

ipcMain.handle('image:read-metadata', (event, filePath) => {
  return readImageMetadata(filePath);
});

ipcMain.handle('image:get-thumbnail', async (event, { filePath, maxSize }) => {
  try {
    const cacheKey = `${filePath}:${maxSize || THUMBNAIL_SIZE}`;
    
    if (thumbnailCache.has(cacheKey)) {
      updateCacheAccess(cacheKey);
      return { data: thumbnailCache.get(cacheKey).toString('base64'), cached: true };
    }
    
    const thumbnailPath = getThumbnailPath(filePath);
    if (fs.existsSync(thumbnailPath)) {
      const cachedData = fs.readFileSync(thumbnailPath);
      thumbnailCache.set(cacheKey, cachedData);
      updateCacheAccess(cacheKey);
      evictLRU();
      return { data: cachedData.toString('base64'), cached: true };
    }
    
    const thumbnailBuffer = await generateThumbnail(filePath, maxSize || THUMBNAIL_SIZE);
    if (!thumbnailBuffer) {
      return { data: null, cached: false };
    }
    
    try {
      fs.writeFileSync(thumbnailPath, thumbnailBuffer);
    } catch (writeError) {
      console.error('保存缩略图缓存失败:', writeError);
    }
    
    thumbnailCache.set(cacheKey, thumbnailBuffer);
    updateCacheAccess(cacheKey);
    evictLRU();
    
    return { data: thumbnailBuffer.toString('base64'), cached: false };
  } catch (error) {
    console.error('获取缩略图失败:', error);
    return { data: null, cached: false };
  }
});

ipcMain.handle('image:get-preview', async (event, { filePath, previewSize }) => {
  try {
    const ext = path.extname(filePath).toLowerCase();
    const isRaw = ['.cr2', '.cr3', '.arw', '.nef', '.dng', '.raw'].includes(ext);
    
    if (isRaw) {
      const embeddedJpeg = getEmbeddedJpegFromRaw(filePath);
      if (embeddedJpeg) {
        return { data: embeddedJpeg.toString('base64'), isRaw: true };
      }
    }
    
    return { data: null, isRaw };
  } catch (error) {
    console.error('获取预览失败:', error);
    return { data: null, isRaw: false };
  }
});

ipcMain.handle('image:clear-cache', () => {
  thumbnailCache.clear();
  cacheAccessOrder = [];
  return true;
});

// 监听窗口控制操作
ipcMain.handle('window:minimize', () => {
  if (mainWindow) {
    mainWindow.minimize();
  }
});

ipcMain.handle('window:maximize', () => {
  if (mainWindow) {
    if (mainWindow.isMaximized()) {
      mainWindow.unmaximize();
    } else {
      mainWindow.maximize();
    }
  }
});

ipcMain.handle('window:close', () => {
  if (mainWindow) {
    mainWindow.close();
  }
});

// 保存应用状态
function saveAppState(state) {
  try {
    const userHome = app.getPath('home');
    const dataDir = path.join(userHome, '.photo_manager');
    const statePath = path.join(dataDir, 'app_state.json');

    // 确保目录存在
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }

    // 保存状态
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
    return true;
  } catch (error) {
    console.error('保存应用状态失败:', error);
    return false;
  }
}

// 读取应用状态
function loadAppState() {
  try {
    const userHome = app.getPath('home');
    const dataDir = path.join(userHome, '.photo_manager');
    const statePath = path.join(dataDir, 'app_state.json');

    if (fs.existsSync(statePath)) {
      const data = fs.readFileSync(statePath, 'utf8');
      return JSON.parse(data);
    }
    return null;
  } catch (error) {
    console.error('读取应用状态失败:', error);
    return null;
  }
}

// 监听保存应用状态请求
ipcMain.handle('app:save-state', (event, state) => {
  return saveAppState(state);
});

// 监听读取应用状态请求
ipcMain.handle('app:load-state', () => {
  return loadAppState();
});