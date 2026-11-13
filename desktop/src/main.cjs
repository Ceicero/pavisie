'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { BrowserWindow, app, dialog, ipcMain, session, shell } = require('electron');
const { apiGet } = require('./lib/api-client.cjs');
const { normalizeApiUrl } = require('./lib/api-url.cjs');
const { createSettingsStore } = require('./lib/settings.cjs');

const SESSION_COOKIE_NAME = 'sid';
/** A persistent partition of its own, so the Discord sign-in survives restarts and is shared with nothing else. */
const AUTH_PARTITION = 'persist:pavisie-auth';
const RENDERER_DIR = path.join(__dirname, 'renderer');

let mainWindow = null;
let loginWindow = null;
let settingsStore = null;

function authSession() {
  return session.fromPartition(AUTH_PARTITION);
}

/** The `Cookie` header for the API, built from whatever the sign-in window stored for that address. */
async function cookieHeaderFor(apiUrl) {
  const cookies = await authSession().cookies.get({ url: apiUrl });
  return cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
}

async function hasSessionCookie(apiUrl) {
  const cookies = await authSession().cookies.get({ url: apiUrl, name: SESSION_COOKIE_NAME });
  return cookies.length > 0;
}

async function clearAuth() {
  await authSession().clearStorageData();
}

async function get(pathname, query) {
  const { apiUrl } = settingsStore.load();
  return apiGet({ apiUrl, path: pathname, query, cookieHeader: await cookieHeaderFor(apiUrl) });
}

/**
 * Opens Discord's own sign-in page in a separate window. This app never sees the Discord password: the API
 * finishes the sign-in and hands back a session cookie, which is all that is kept.
 */
function signIn() {
  if (loginWindow) {
    loginWindow.focus();
    return Promise.resolve({
      ok: false,
      code: 'in_progress',
      message: 'The sign-in window is already open.',
    });
  }
  const { apiUrl } = settingsStore.load();

  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (loginWindow && !loginWindow.isDestroyed()) loginWindow.close();
      resolve(result);
    };

    loginWindow = new BrowserWindow({
      width: 520,
      height: 760,
      parent: mainWindow ?? undefined,
      modal: Boolean(mainWindow),
      title: 'Sign in with Discord',
      autoHideMenuBar: true,
      backgroundColor: '#0d0d0d',
      webPreferences: {
        partition: AUTH_PARTITION,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    loginWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

    // The API sets the session cookie on its callback and then redirects to the website dashboard. The moment
    // the cookie exists the sign-in is done, so close this window rather than show the website inside it.
    const checkSignedIn = async () => {
      if (settled || !(await hasSessionCookie(apiUrl).catch(() => false))) return;
      finish({ ok: true });
    };
    loginWindow.webContents.on('will-redirect', () => checkSignedIn());
    loginWindow.webContents.on('did-navigate', () => checkSignedIn());
    loginWindow.webContents.on('did-fail-load', (_event, code, description, _url, isMainFrame) => {
      // -3 is "aborted": the window was closed mid-load once the cookie arrived, which is the normal ending.
      if (!isMainFrame || code === -3) return;
      checkSignedIn().then(() =>
        finish({
          ok: false,
          code: 'unreachable',
          message: `Could not open the sign-in page (${description}). Check the API address.`,
        }),
      );
    });
    loginWindow.on('closed', () => {
      loginWindow = null;
      finish({ ok: false, code: 'cancelled', message: 'Sign-in was cancelled.' });
    });

    // Drop any old session cookie first so a stale one cannot be mistaken for a finished sign-in. Discord's
    // own cookies stay, so signing in again does not mean typing the Discord password again.
    authSession()
      .cookies.remove(apiUrl, SESSION_COOKIE_NAME)
      .then(() => loginWindow?.loadURL(`${apiUrl}/auth/discord/login`))
      .catch(() =>
        finish({
          ok: false,
          code: 'unreachable',
          message: 'Could not open the sign-in page. Check the API address.',
        }),
      );
  });
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 900,
    minHeight: 620,
    title: 'Pavisie Dev',
    autoHideMenuBar: true,
    backgroundColor: '#0d0d0d',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // The window only ever shows this app's own pages. Links open in the real browser; nothing navigates away.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault());
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  mainWindow.loadFile(path.join(RENDERER_DIR, 'index.html'));
}

function registerIpc() {
  ipcMain.handle('app:state', async () => {
    const settings = settingsStore.load();
    const me = await get('/auth/me');
    return {
      settings,
      version: app.getVersion(),
      user: me.ok ? me.data.user : null,
      authError: me.ok ? null : me,
    };
  });

  ipcMain.handle('api:get', (_event, pathname, query) => get(String(pathname), query));
  ipcMain.handle('auth:sign-in', () => signIn());
  ipcMain.handle('auth:sign-out', async () => {
    // Local sign-out: forget the cookie on this computer. The server-side session expires on its own.
    await clearAuth();
    return { ok: true };
  });

  ipcMain.handle('settings:save', async (_event, patch) => {
    const before = settingsStore.load();
    const next = { ...patch };
    if (next.apiUrl !== undefined) {
      try {
        next.apiUrl = normalizeApiUrl(next.apiUrl);
      } catch (error) {
        return { ok: false, message: error.message };
      }
      // A different server means a different login; never send one server's cookie setup to another.
      if (next.apiUrl !== before.apiUrl) await clearAuth();
    }
    return { ok: true, settings: settingsStore.save(next) };
  });

  ipcMain.handle('snapshot:export', async (_event, snapshot) => {
    const stamp = new Date().toISOString().slice(0, 10);
    const result = await dialog.showSaveDialog(mainWindow, {
      title: 'Export stats snapshot',
      defaultPath: `pavisie-stats-${stamp}.json`,
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (result.canceled || !result.filePath) return { ok: false, code: 'cancelled' };
    fs.writeFileSync(result.filePath, JSON.stringify(snapshot, null, 2));
    return { ok: true, filePath: result.filePath };
  });
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.whenReady().then(() => {
    settingsStore = createSettingsStore(app.getPath('userData'));
    // Nothing in this app needs camera, location, notifications, or any other permission.
    for (const ses of [session.defaultSession, authSession()]) {
      ses.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
    }
    registerIpc();
    createMainWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
