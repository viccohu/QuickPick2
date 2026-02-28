const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const ExifReader = require('exifreader');
const { exiftool } = require('exiftool-vendored');
const sharp = require('sharp');

// 创建日志目录
const logDir = path.join(app.getPath('userData'), 'logs');
if (!fs.existsSync(logDir)) {
  fs.mkdirSync(logDir, { recursive: true });
}

// 日志文件路径
const logFile = path.join(logDir, `app-${new Date().toISOString().slice(0, 10)}.log`);

// 日志记录函数
function log(message, level = 'info') {
  const timestamp = new Date().toISOString();
  const logMessage = `[${timestamp}] [${level.toUpperCase()}] ${message}\n`;
  console.log(logMessage);
  fs.appendFileSync(logFile, logMessage, 'utf8');
}

// 全局未捕获异常处理
process.on('uncaughtException', (error) => {
  log(`未捕获的异常: ${error.message}\n${error.stack}`, 'error');
  dialog.showMessageBox({
    type: 'error',
    title: '应用崩溃',
    message: '应用遇到未预期的错误',
    detail: `错误信息: ${error.message}\n\n请查看日志文件获取详细信息: ${logFile}`,
    buttons: ['确定']
  }).then(() => {
    app.quit();
  });
});

// 全局未处理的 Promise 拒绝处理
process.on('unhandledRejection', (reason, promise) => {
  log(`未处理的 Promise 拒绝: ${reason}\n${promise}`, 'error');
  dialog.showMessageBox({
    type: 'error',
    title: '应用错误',
    message: '应用遇到未处理的操作',
    detail: `错误信息: ${reason}\n\n请查看日志文件获取详细信息: ${logFile}`,
    buttons: ['确定']
  });
});

// 导入 Native 模块
let nativeBridge = null;
try {
    nativeBridge = require('./src/native_bridge');
    console.log('[Main] Native bridge loaded:', nativeBridge.getStatus());
} catch (e) {
    console.warn('[Main] Native bridge not available:', e.message);
}

const THUMBNAIL_SIZE = 240;
const THUMBNAIL_QUALITY = 80;
const MAX_CACHE_ITEMS = 500;
const CACHE_CLEANUP_THRESHOLD = 0.8;

let thumbnailCache = new Map();
let cacheAccessMap = new Map();
let cacheAccessCounter = 0;
let cacheDir = null;
let ratingQueue = [];
let isProcessingRatingQueue = false;
let metadataCache = new Map();

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
  return path.join(getCacheDir(), `${hash}.jpg`);
}

function extractRawPreview(filePath) {
  try {
    const buffer = fs.readFileSync(filePath);
    const ext = path.extname(filePath).toLowerCase();
    
    if (['.cr2', '.cr3'].includes(ext)) {
      return extractCanonPreview(buffer);
    } else if (ext === '.arw') {
      return extractSonyPreview(buffer);
    } else if (ext === '.nef') {
      return extractNikonPreview(buffer);
    } else if (['.dng', '.raw'].includes(ext)) {
      return extractTiffPreview(buffer);
    }
    
    return extractGenericJpeg(buffer);
  } catch (error) {
    console.error('提取RAW预览失败:', error);
    return null;
  }
}

function extractCanonPreview(buffer) {
  let offset = 0;
  while (offset < Math.min(buffer.length, 100000)) {
    if (buffer[offset] === 0xFF && buffer[offset + 1] === 0xD8) {
      let end = offset + 2;
      while (end < buffer.length - 1) {
        if (buffer[end] === 0xFF && buffer[end + 1] === 0xD9) {
          return buffer.slice(offset, end + 2);
        }
        end++;
      }
    }
    offset++;
  }
  return null;
}

function extractSonyPreview(buffer) {
  if (buffer.length < 8) return null;
  
  const le = buffer.readUInt32LE(4);
  const offset = le === 0x49492A00 ? 8 : 0;
  
  for (let i = offset; i < Math.min(buffer.length, 50000); i++) {
    if (buffer[i] === 0xFF && buffer[i + 1] === 0xD8) {
      let end = i + 2;
      while (end < buffer.length - 1) {
        if (buffer[end] === 0xFF && buffer[end + 1] === 0xD9) {
          return buffer.slice(i, end + 2);
        }
        end++;
      }
    }
  }
  return null;
}

function extractNikonPreview(buffer) {
  for (let i = 0; i < Math.min(buffer.length, 100000); i++) {
    if (buffer[i] === 0xFF && buffer[i + 1] === 0xD8) {
      let end = i + 2;
      while (end < buffer.length - 1) {
        if (buffer[end] === 0xFF && buffer[end + 1] === 0xD9) {
          return buffer.slice(i, end + 2);
        }
        end++;
      }
    }
  }
  return null;
}

function extractTiffPreview(buffer) {
  for (let i = 0; i < Math.min(buffer.length, 200000); i++) {
    if (buffer[i] === 0xFF && buffer[i + 1] === 0xD8) {
      let end = i + 2;
      while (end < buffer.length - 1) {
        if (buffer[end] === 0xFF && buffer[end + 1] === 0xD9) {
          return buffer.slice(i, end + 2);
        }
        end++;
      }
    }
  }
  return null;
}

function extractGenericJpeg(buffer) {
  for (let i = 0; i < Math.min(buffer.length, 500000); i++) {
    if (buffer[i] === 0xFF && buffer[i + 1] === 0xD8) {
      let end = i + 2;
      while (end < buffer.length - 1) {
        if (buffer[end] === 0xFF && buffer[end + 1] === 0xD9) {
          return buffer.slice(i, end + 2);
        }
        end++;
      }
    }
  }
  return null;
}

async function generateThumbnail(filePath, maxSize = THUMBNAIL_SIZE) {
  try {
    const settings = getSettings();
    const jpgProcessor = settings.jpgProcessor || 'wic';
    const thumbnailQuality = settings.thumbnailQuality || 80;
    
    if (jpgProcessor === 'wic' && nativeBridge && nativeBridge.getWICThumbnail) {
      const wicResult = await nativeBridge.getWICThumbnail(filePath, maxSize);
      if (wicResult && wicResult.data) {
        return Buffer.from(wicResult.data, 'base64');
      }
    }
    
    const ext = path.extname(filePath).toLowerCase();
    const isRaw = ['.cr2', '.cr3', '.arw', '.nef', '.dng', '.raw'].includes(ext);
    
    let imageBuffer;
    if (isRaw) {
      imageBuffer = extractRawPreview(filePath);
      if (!imageBuffer) {
        return null;
      }
    } else {
      imageBuffer = fs.readFileSync(filePath);
    }
    
    try {
      const thumbnail = await sharp(imageBuffer)
        .resize(maxSize, maxSize, {
          fit: 'inside',
          withoutEnlargement: true,
          fastShrinkOnLoad: true
        })
        .jpeg({
          quality: thumbnailQuality,
          mozjpeg: true,
          chromaSubsampling: '4:2:0'
        })
        .toBuffer();
      
      return thumbnail;
    } catch (sharpError) {
      console.error('Sharp处理失败:', sharpError);
      return imageBuffer;
    }
  } catch (error) {
    console.error('生成缩略图失败:', error);
    return null;
  }
}

function updateCacheAccess(key) {
  cacheAccessCounter++;
  cacheAccessMap.set(key, cacheAccessCounter);
}

function evictLRU() {
  if (thumbnailCache.size <= MAX_CACHE_ITEMS * CACHE_CLEANUP_THRESHOLD) {
    return;
  }
  
  const entries = Array.from(cacheAccessMap.entries());
  entries.sort((a, b) => a[1] - b[1]);
  
  const itemsToEvict = Math.floor(MAX_CACHE_ITEMS * 0.2);
  for (let i = 0; i < itemsToEvict && i < entries.length; i++) {
    const key = entries[i][0];
    thumbnailCache.delete(key);
    cacheAccessMap.delete(key);
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
  try {
    log('开始创建主窗口');
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
    mainWindow.loadFile('index.html').then(() => {
      log('主页面加载成功');
    }).catch((error) => {
      log(`加载主页面失败: ${error.message}`, 'error');
    });

    // 允许使用F12开启开发者工具
    mainWindow.webContents.on('before-input-event', (event, input) => {
      if (input.key === 'F12') {
        mainWindow.webContents.toggleDevTools();
        event.preventDefault();
      }
    });

    // 监听窗口关闭事件
    mainWindow.on('closed', function () {
      log('主窗口关闭');
      mainWindow = null;
    });

    // 监听渲染进程崩溃
    mainWindow.webContents.on('crashed', (event, killed) => {
      log(`渲染进程崩溃: ${killed ? '被杀死' : '意外崩溃'}`, 'error');
      dialog.showMessageBox({
        type: 'error',
        title: '渲染进程崩溃',
        message: '应用界面进程崩溃',
        detail: '渲染进程已崩溃，应用将重新启动',
        buttons: ['确定']
      }).then(() => {
        createWindow();
      });
    });

    // 监听白屏事件
    mainWindow.webContents.on('render-process-gone', (event, details) => {
      log(`渲染进程消失: ${details.reason}`, 'error');
      dialog.showMessageBox({
        type: 'error',
        title: '渲染进程错误',
        message: '应用界面进程出现错误',
        detail: `原因: ${details.reason}\n\n请查看日志文件获取详细信息: ${logFile}`,
        buttons: ['确定']
      }).then(() => {
        createWindow();
      });
    });

    log('主窗口创建成功');
  } catch (error) {
    log(`创建窗口失败: ${error.message}\n${error.stack}`, 'error');
    throw error;
  }
}

// 初始化WIC
if (nativeBridge && nativeBridge.initWICPreview) {
  try {
    nativeBridge.initWICPreview();
    log('[Main] WIC preview initialized');
  } catch (error) {
    log(`初始化WIC失败: ${error.message}`, 'error');
  }
}

// 应用就绪后创建窗口
app.whenReady().then(() => {
  try {
    log('应用就绪，创建主窗口');
    createWindow();
  } catch (error) {
    log(`创建窗口失败: ${error.message}\n${error.stack}`, 'error');
    dialog.showMessageBox({
      type: 'error',
      title: '启动失败',
      message: '应用启动失败',
      detail: `错误信息: ${error.message}\n\n请查看日志文件获取详细信息: ${logFile}`,
      buttons: ['确定']
    }).then(() => {
      app.quit();
    });
  }
});

// 监听所有窗口关闭事件
app.on('window-all-closed', function () {
  if (nativeBridge && nativeBridge.stopPreload) {
    nativeBridge.stopPreload();
  }
  if (process.platform !== 'darwin') app.quit();
});

// 监听应用退出
app.on('will-quit', () => {
  if (nativeBridge && nativeBridge.uninitWICPreview) {
    nativeBridge.uninitWICPreview();
    console.log('[Main] WIC preview uninitialized');
  }
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
    try {
      fs.readdir(dirPath, (err, files) => {
        if (err) {
          console.error('读取目录失败:', err);
          reject(err);
        } else {
          resolve(files);
        }
      });
    } catch (error) {
      console.error('读取目录异常:', error);
      reject(error);
    }
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
  try {
    return fs.existsSync(path);
  } catch (error) {
    console.error('检查路径存在失败:', error);
    return false;
  }
});

ipcMain.handle('fs:mkdirSync', (event, { path, options }) => {
  try {
    return fs.mkdirSync(path, options);
  } catch (error) {
    console.error('创建目录失败:', error);
    throw error;
  }
});

ipcMain.handle('fs:deleteFile', async (event, filePath) => {
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      return true;
    }
    return false;
  } catch (error) {
    console.error('删除文件失败:', error);
    throw error;
  }
});

// 监听图片评级操作
ipcMain.handle('image:read-rating', async (event, filePath) => {
  try {
    return await getImageRating(filePath);
  } catch (error) {
    log(`读取图片评级失败: ${error.message}`, 'error');
    return 0;
  }
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

const rawPreviewCache = new Map();
const backgroundDecodeQueue = new Map();

ipcMain.handle('image:get-preview', async (event, { filePath, previewSize }) => {
  try {
    const ext = path.extname(filePath).toLowerCase();
    const isRaw = ['.cr2', '.cr3', '.arw', '.nef', '.dng', '.raw'].includes(ext);
    
    if (isRaw) {
      console.log('[RAW Preview] Processing:', filePath);
      
      if (rawPreviewCache.has(filePath)) {
        console.log('[RAW Preview] Using cached preview');
        return rawPreviewCache.get(filePath);
      }
      
      if (nativeBridge && nativeBridge.getWICPreview) {
        console.log('[RAW Preview] Calling getWICPreview...');
        const wicResult = await nativeBridge.getWICPreview(filePath, previewSize || 2000);
        console.log('[RAW Preview] WIC result:', wicResult ? `success, ${wicResult.width}x${wicResult.height}, embedded=${wicResult.embeddedJpeg}, needsBg=${wicResult.needsBackgroundDecode}` : 'null');
        
        if (wicResult && wicResult.data) {
          const result = { 
            data: wicResult.data, 
            isRaw: true,
            width: wicResult.width,
            height: wicResult.height,
            isPreview: false
          };
          
          rawPreviewCache.set(filePath, result);
          
          console.log('[RAW Preview] WIC decode success:', wicResult.width, 'x', wicResult.height);
          return result;
        }
      }
      
      if (nativeBridge) {
        const nativeResult = await nativeBridge.getRawPreview(filePath);
        console.log('[RAW Preview] Native result:', nativeResult ? `${nativeResult.width}x${nativeResult.height}` : 'null');
        if (nativeResult && nativeResult.data) {
          const result = { 
            data: nativeResult.data, 
            isRaw: true,
            width: nativeResult.width,
            height: nativeResult.height
          };
          rawPreviewCache.set(filePath, result);
          console.log('[RAW Preview] Using embedded JPEG');
          return result;
        }
      }
      
      const embeddedJpeg = extractRawPreview(filePath);
      if (embeddedJpeg) {
        console.log('[RAW Preview] Using JS extracted JPEG');
        const result = { data: embeddedJpeg.toString('base64'), isRaw: true };
        rawPreviewCache.set(filePath, result);
        return result;
      }
      
      console.log('[RAW Preview] No preview found');
    }
    
    return { data: null, isRaw };
  } catch (error) {
    console.error('获取预览失败:', error);
    return { data: null, isRaw: false };
  }
});

ipcMain.handle('image:set-current-file', async (event, { filePath, fileList }) => {
  if (nativeBridge) {
    if (fileList && fileList.length > 0) {
      nativeBridge.setFileList(fileList);
      nativeBridge.startPreload();
    }
    if (filePath) {
      nativeBridge.setCurrentFile(filePath);
    }
  }
  return true;
});

ipcMain.handle('image:clear-cache', () => {
  thumbnailCache.clear();
  cacheAccessOrder = [];
  rawPreviewCache.clear();
  if (nativeBridge && nativeBridge.clearWICCache) {
    nativeBridge.clearWICCache();
  }
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

// ==================== Native 模块 IPC 处理 ====================

// 获取 Native 模块状态
ipcMain.handle('native:get-status', () => {
  if (nativeBridge) {
    return nativeBridge.getStatus();
  }
  return { nativeAvailable: false, modules: [] };
});

// 批量生成缩略图
ipcMain.handle('native:generate-thumbnails', async (event, { paths, options }) => {
  if (!nativeBridge) {
    return { error: 'Native module not available' };
  }
  
  try {
    const results = await nativeBridge.generateThumbnails(paths, options);
    // 将 Buffer 转换为 base64
    const processed = {};
    for (const [path, data] of Object.entries(results)) {
      if (data.data) {
        processed[path] = {
          data: data.data.toString('base64'),
          width: data.width,
          height: data.height
        };
      }
    }
    return processed;
  } catch (error) {
    console.error('[Native] Generate thumbnails error:', error);
    return { error: error.message };
  }
});

// 批量读取 EXIF 评级
ipcMain.handle('native:read-exif-ratings', async (event, { paths }) => {
  if (!nativeBridge) {
    return { error: 'Native module not available' };
  }
  
  try {
    const results = await nativeBridge.readExifRatings(paths);
    return results;
  } catch (error) {
    console.error('[Native] Read EXIF ratings error:', error);
    return { error: error.message };
  }
});

// 快速文件扫描
ipcMain.handle('native:scan-files', async (event, { directories, extensions }) => {
  if (!nativeBridge) {
    return { error: 'Native module not available' };
  }
  
  try {
    const files = await nativeBridge.scanFiles(directories, extensions);
    return files;
  } catch (error) {
    console.error('[Native] Scan files error:', error);
    return { error: error.message };
  }
});

// ==================== 设置模块 IPC 处理 ====================
const { getSettings, getSetting, setSetting, setSettings, resetSettings } = require('./src/settings');

ipcMain.handle('settings:get', () => {
  return getSettings();
});

ipcMain.handle('settings:get-one', (event, key) => {
  return getSetting(key);
});

ipcMain.handle('settings:set', (event, settings) => {
  setSettings(settings);
  return true;
});

ipcMain.handle('settings:set-one', (event, { key, value }) => {
  setSetting(key, value);
  return true;
});

ipcMain.handle('settings:reset', () => {
  resetSettings();
  return true;
});