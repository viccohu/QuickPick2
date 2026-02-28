const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const defaultSettings = {
  exportMode: 'jpg&raw',
  exportRatingThreshold: 5,
  exportFolderNameJPG: 'JPG',
  exportFolderNameRAW: 'raw',
  fileConflictAction: 'ask',
  themeMode: 'dark',
  enableAnimation: true,
  zoomLevel: 2.5,
  rememberLastPath: true,
  lastJPGPath: '',
  lastRAWPath: '',
  defaultJPGPath: '',
  defaultRAWPath: '',
  autoLoadOnStartup: false,
  thumbnailQuality: 80,
  jpgProcessor: 'wic',
  cacheSize: 500
};

let settingsPath = null;
let cachedSettings = null;

function getSettingsPath() {
  if (!settingsPath) {
    const userDataPath = app.getPath('userData');
    settingsPath = path.join(userDataPath, 'settings.json');
  }
  return settingsPath;
}

function getSettings() {
  if (cachedSettings) {
    return cachedSettings;
  }
  
  try {
    const filePath = getSettingsPath();
    if (fs.existsSync(filePath)) {
      const data = fs.readFileSync(filePath, 'utf8');
      const saved = JSON.parse(data);
      cachedSettings = { ...defaultSettings, ...saved };
    } else {
      cachedSettings = { ...defaultSettings };
    }
  } catch (error) {
    console.error('[Settings] Error loading settings:', error);
    cachedSettings = { ...defaultSettings };
  }
  
  return cachedSettings;
}

function getSetting(key) {
  const settings = getSettings();
  return settings[key];
}

function setSetting(key, value) {
  const settings = getSettings();
  settings[key] = value;
  cachedSettings = settings;
  saveSettings(settings);
}

function setSettings(newSettings) {
  cachedSettings = { ...defaultSettings, ...newSettings };
  saveSettings(cachedSettings);
}

function saveSettings(settings) {
  try {
    const filePath = getSettingsPath();
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(filePath, JSON.stringify(settings, null, 2));
  } catch (error) {
    console.error('[Settings] Error saving settings:', error);
  }
}

function resetSettings() {
  cachedSettings = { ...defaultSettings };
  saveSettings(cachedSettings);
}

module.exports = {
  getSettings,
  getSetting,
  setSetting,
  setSettings,
  resetSettings,
  defaultSettings
};
