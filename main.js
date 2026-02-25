const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const ExifReader = require('exifreader');
const { exiftool } = require('exiftool-vendored');

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

// 监听图片元数据读取请求
ipcMain.handle('image:read-metadata', (event, filePath) => {
  return readImageMetadata(filePath);
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