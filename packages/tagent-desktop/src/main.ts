import { app, BrowserWindow, ipcMain, globalShortcut, Tray, Menu, screen } from 'electron';
import * as path from 'path';
import { fork, ChildProcess } from 'child_process';
import * as fs from 'fs';

let mainWindow: BrowserWindow | null = null;
let serverProcess: ChildProcess | null = null;
let tray: Tray | null = null;

const isDev = !app.isPackaged;

// 配置数据隔离目录 (Plan §3.2)
const userDataPath = path.join(app.getPath('appData'), 'TAgent');
if (!fs.existsSync(userDataPath)) {
  fs.mkdirSync(userDataPath, { recursive: true });
}

function startServer() {
  console.log('Starting tagent-server...');
  // 生产环境下 server 的路径不同
  const serverScript = isDev 
    ? path.join(__dirname, '../../tagent-server/dist/index.js')
    : path.join(__dirname, '../tagent-server/dist/index.js'); // 这里后续需要结合打包路径调整

  try {
    serverProcess = fork(serverScript, [], {
      env: {
        ...process.env,
        TAGENT_DATA_DIR: userDataPath,
        PORT: '3001'
      },
      stdio: 'inherit'
    });

    serverProcess.on('error', (err) => {
      console.error('Server process failed to start:', err);
    });
  } catch (e) {
    console.error('Failed to fork server:', e);
  }
}

function createWindow() {
  const primaryDisplay = screen.getPrimaryDisplay();
  const { width, height } = primaryDisplay.workAreaSize;

  mainWindow = new BrowserWindow({
    width: Math.min(1200, width * 0.8),
    height: Math.min(800, height * 0.8),
    frame: false, // 无边框窗口设计 (Plan §2)
    transparent: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    },
    show: false, // 准备好后再显示，防止白屏闪烁
  });

  const url = isDev ? 'http://localhost:3000' : `file://${path.join(__dirname, '../tagent-web/out/index.html')}`;
  
  if (isDev) {
    // Dev 模式下等待 Next.js 启动
    mainWindow.loadURL(url);
    mainWindow.webContents.openDevTools();
  } else {
    // Prod 模式下加载静态文件
    mainWindow.loadFile(path.join(__dirname, '../../tagent-web/out/index.html'));
  }

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // 全局快捷键唤出 (Plan §2)
  globalShortcut.register('CommandOrControl+Shift+A', () => {
    if (mainWindow) {
      if (mainWindow.isVisible()) {
        mainWindow.hide();
      } else {
        mainWindow.show();
        mainWindow.focus();
      }
    }
  });

  // IPC 控制窗口最大化/最小化/关闭 (配合无边框窗口)
  ipcMain.on('window-controls', (event, action) => {
    if (!mainWindow) return;
    switch (action) {
      case 'minimize':
        mainWindow.minimize();
        break;
      case 'maximize':
        if (mainWindow.isMaximized()) {
          mainWindow.unmaximize();
        } else {
          mainWindow.maximize();
        }
        break;
      case 'close':
        mainWindow.hide(); // 隐藏到托盘而不是直接退出
        break;
    }
  });
}

function createTray() {
  // 托盘图标 (需要一个简单的占位图标)
  // 此处假设项目根目录有个 icon.png
  tray = new Tray(path.join(__dirname, 'icon.png')); // TODO: Provide real icon
  const contextMenu = Menu.buildFromTemplate([
    { label: '打开 TAgent', click: () => mainWindow?.show() },
    { type: 'separator' },
    { label: '退出', click: () => {
      app.quit();
    }}
  ]);
  tray.setToolTip('TAgent 正在后台运行');
  tray.setContextMenu(contextMenu);

  tray.on('click', () => {
    mainWindow?.show();
  });
}

app.whenReady().then(() => {
  // 由于托盘需要图标，如果没有图标会报错，我们临时跳过托盘创建，除非放了真实图标。
  // createTray(); 
  
  startServer();
  
  // 等待服务器稍微启动一下再建窗口
  setTimeout(() => {
    createWindow();
  }, 1000);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  globalShortcut.unregisterAll();
  if (serverProcess) {
    serverProcess.kill();
  }
});
