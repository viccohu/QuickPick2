# QuickPick2 - Windows桌面图片查看管理器

<div align="center">
  <img src="icon.ico" alt="QuickPick2 Logo" width="120" height="120">
  
  **专业的图片筛选与管理工具**
  
  [![Electron](https://img.shields.io/badge/Electron-29.4.6-blue)](https://www.electronjs.org/)
  [![Node.js](https://img.shields.io/badge/Node.js-20+-green)](https://nodejs.org/)
  [![Platform](https://img.shields.io/badge/Platform-Windows-lightgrey)](https://www.microsoft.com/windows)
  [![License](https://img.shields.io/badge/License-ISC-yellow)](LICENSE)
</div>

---

## 📖 项目简介

QuickPick2 是一款专为摄影师设计的 Windows 桌面图片查看管理器，支持 JPG/RAW 格式图片预览、双路径管理、星级评分、智能筛选、分级导出等功能。采用 Electron + Native C++ 混合架构，性能优异。

---

## ✨ 核心功能

### 📁 双路径管理
- 支持设置独立的 JPG 和 RAW 文件路径
- 自动扫描并按文件名前缀匹配 JPG/RAW 图片组
- 支持多种 RAW 格式：CR2, CR3, NEF, ARW, DNG, RAF, ORF, RW2, PEF, SRW, X3F

### 🖼️ 图片预览
- 大图预览，支持鼠标滚轮缩放、拖拽移动
- 键盘左右键快速切换图片
- 自动适配窗口大小
- 支持 JPG/RAW 双格式预览

### 📊 缩略图堆叠
- 底部缩略图展示栏，横向滚动
- JPG 和 RAW 文件自动堆叠显示
- 缩略图显示格式标签和星级评级
- 点击缩略图快速切换图片

### ⭐ 星级评分系统
- 1-5 星评级系统
- 点击评级，再次点击取消
- 评级数据持久化存储
- 支持快捷键评级（数字键 1-5）

### 🔍 智能筛选
- **格式筛选**：仅 JPG / 仅 RAW / 双格式 / 全部
- **星级筛选**：等于 / 大于等于 / 小于等于 / 无星 / 有星
- 实时显示筛选统计
- 筛选状态可视化

### 📤 分级导出
- 4 星级及以下：仅导出 JPG 文件
- 5 星级：同时导出 JPG 和 RAW 文件
- 自动创建目标子文件夹
- 导出完成显示统计信息

---

## 🚀 性能优化

### Native C++ 模块
QuickPick2 采用 **Electron + Native C++** 混合架构，性能关键操作使用 C++ 实现：

| 模块 | 实现方式 | 性能提升 |
|------|---------|---------|
| 文件扫描 | Native C++ (Windows API) | **10x** |
| 缩略图生成 | Native C++ | **10x** |
| EXIF 读取 | JavaScript (exiftool) | 可靠 |

### 智能缓存系统
- LRU 缓存算法
- 缩略图缓存 (200MB)
- 预览图缓存 (500MB)
- 自动清理过期缓存

### 虚拟滚动
- 只渲染可见区域缩略图
- 支持大量图片流畅滚动
- 内存占用优化

---

## 🛠️ 环境搭建

### 前置要求
- **Node.js** 18+ ([下载](https://nodejs.org/))
- **Visual Studio Build Tools 2022** (用于编译 Native 模块，可选)

### 安装步骤

```bash
# 1. 克隆项目
git clone https://github.com/viccohu/QuickPick2.git
cd QuickPick2

# 2. 安装依赖
npm install

# 3. 编译 Native 模块（可选，需要 Visual Studio Build Tools）
npm run build:native

# 4. 运行应用
npm start
```

### 编译 Native 模块（可选）

如果需要启用 Native 模块以获得最佳性能：

1. 下载 [Visual Studio Build Tools 2022](https://aka.ms/vs/17/release/vs_BuildTools.exe)
2. 安装时选择 **"Desktop development with C++"**
3. 运行编译命令：
   ```bash
   npm run build:native
   ```

---

## 📦 打包发布

```bash
# 打包成 EXE
npm run build
```

构建完成后，可执行文件将生成在 `dist` 目录中。

---

## 🎮 使用指南

### 快捷键

| 快捷键 | 功能 |
|--------|------|
| `←` / `→` | 上一张 / 下一张图片 |
| `1-5` | 设置 1-5 星评级 |
| `0` | 取消评级 |
| `Delete` | 删除当前图片 |
| `F11` | 全屏模式 |
| `F12` | 开发者工具 |
| `Ctrl+O` | 打开路径设置 |
| `Ctrl+E` | 导出标星文件 |

### 操作流程

1. **设置路径**：输入或选择 JPG/RAW 文件路径
2. **加载图片**：点击「加载」按钮扫描图片
3. **浏览筛选**：使用筛选功能快速定位图片
4. **评级打分**：为图片设置星级评分
5. **导出文件**：导出标星文件到目标目录

---

## 📁 项目结构

```
QuickPick2/
├── main.js                    # Electron 主进程
├── preload.js                 # 预加载脚本
├── index.html                 # 主界面
├── package.json               # 项目配置
├── native/                    # Native C++ 模块
│   ├── binding.gyp           # Node-gyp 配置
│   └── quickpick_native.cc   # C++ 源码
├── src/                       # JavaScript 模块
│   ├── native_bridge.js      # Native 模块桥接
│   ├── cache_manager.js      # 缓存管理
│   └── virtual_scroller.js   # 虚拟滚动
├── PERFORMANCE.md             # 性能优化文档
└── README.md                  # 项目说明
```

---

## 🔧 技术栈

| 技术 | 用途 |
|------|------|
| **Electron** | 跨平台桌面应用框架 |
| **Node.js** | 后端运行环境 |
| **Native C++** | 性能关键模块 |
| **Sharp** | 图片处理 |
| **ExifTool** | EXIF 元数据读取 |
| **RemixIcon** | 图标库 |

---

## 📊 性能指标

| 指标 | 数值 |
|------|------|
| 图片加载速度 | ~30s/1000张 (Native) |
| 文件扫描速度 | ~0.2s/1000张 (Native) |
| 内存占用 | ~500MB (1000张图片) |
| 支持图片数量 | 10000+ |

---

## ❓ 常见问题

### Q: Native 模块编译失败？
**A:** 确保已安装 Visual Studio Build Tools 2022，并选择 "Desktop development with C++" 工作负载。

### Q: 图片评级没有显示？
**A:** 检查图片是否包含 EXIF 评级信息。部分相机或编辑软件可能使用不同的评级存储方式。

### Q: 支持哪些 RAW 格式？
**A:** 支持 Canon (CR2, CR3), Nikon (NEF), Sony (ARW), Adobe (DNG), Fujifilm (RAF), Olympus (ORF), Panasonic (RW2), Pentax (PEF), Samsung (SRW), Sigma (X3F) 等。

### Q: 数据存储在哪里？
**A:** 评级数据存储在 `用户目录/.photo_manager/ratings_tags.json`。

---

## 📝 更新日志

### v1.0.0 (2024-02)
- ✨ 初始版本发布
- ✨ 双路径管理
- ✨ 星级评分系统
- ✨ 智能筛选功能
- ✨ 分级导出
- ✨ Native C++ 性能优化模块
- ✨ 智能缓存系统
- ✨ 虚拟滚动优化

---

## 🤝 贡献指南

欢迎提交 Issue 和 Pull Request！

1. Fork 本仓库
2. 创建特性分支 (`git checkout -b feature/AmazingFeature`)
3. 提交更改 (`git commit -m 'Add some AmazingFeature'`)
4. 推送到分支 (`git push origin feature/AmazingFeature`)
5. 提交 Pull Request

---

## 📄 许可证

本项目采用 ISC 许可证 - 详见 [LICENSE](LICENSE) 文件。

---

## 🙏 致谢

- [Electron](https://www.electronjs.org/) - 跨平台桌面应用框架
- [Sharp](https://sharp.pixelplumbing.com/) - 高性能图片处理库
- [ExifTool](https://exiftool.org/) - EXIF 元数据处理
- [RemixIcon](https://remixicon.com/) - 开源图标库

---

<div align="center">
  Made with ❤️ by viccohu
</div>
