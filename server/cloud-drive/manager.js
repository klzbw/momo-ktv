/**
 * 网盘账号管理器
 * 负责：账号增删改查、token 刷新、驱动实例化、扫码会话管理
 */

const fs = require('fs');
const path = require('path');
const Pan115Driver = require('./drivers/pan115');
// const AliyunDriver = require('./drivers/aliyun'); // 后续实现

const DRIVERS = {
  pan115: Pan115Driver,
  // aliyun: AliyunDriver,
};

// 扫码会话内存缓存（重启后丢失，过期自动清理）
const qrSessions = new Map(); // qrId -> { accountId, driver, createdAt, expiresAt }

class CloudDriveManager {
  constructor(db) {
    this.db = db;
    this._initTables();
  }

  // ==================== 数据库初始化 ====================

  _initTables() {
    // 网盘账号表
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS cloud_accounts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        driver TEXT NOT NULL,
        name TEXT NOT NULL,
        access_token TEXT,
        refresh_token TEXT,
        token_expires_at DATETIME,
        user_info TEXT,
        status TEXT DEFAULT 'active',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // 网盘曲库表
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS cloud_libraries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        account_id INTEGER NOT NULL,
        mount_path TEXT NOT NULL,
        local_name TEXT NOT NULL,
        scan_status TEXT DEFAULT 'idle',
        last_scan_at DATETIME,
        song_count INTEGER DEFAULT 0,
        enabled INTEGER DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (account_id) REFERENCES cloud_accounts(id)
      )
    `);

    // 网盘文件缓存表
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS cloud_files (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        library_id INTEGER NOT NULL,
        file_id TEXT NOT NULL,
        file_path TEXT NOT NULL,
        file_name TEXT NOT NULL,
        file_size INTEGER,
        file_hash TEXT,
        song_id INTEGER,
        cached_locally INTEGER DEFAULT 0,
        local_cache_path TEXT,
        last_played_at DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(library_id, file_id),
        FOREIGN KEY (library_id) REFERENCES cloud_libraries(id)
      )
    `);

    // songs 表扩展（增量添加，已存在则忽略）
    try {
      this.db.exec("ALTER TABLE songs ADD COLUMN source_type TEXT DEFAULT 'local'");
    } catch (e) { /* 已存在 */ }
    try {
      this.db.exec("ALTER TABLE songs ADD COLUMN cloud_file_id INTEGER");
    } catch (e) { /* 已存在 */ }
  }

  // ==================== 驱动实例化 ====================

  getDriver(account) {
    const DriverClass = DRIVERS[account.driver];
    if (!DriverClass) {
      throw new Error(`未知网盘驱动类型: ${account.driver}`);
    }
    return new DriverClass(account);
  }

  getDriverById(accountId) {
    const account = this.getAccount(accountId);
    if (!account) throw new Error(`网盘账号不存在: ${accountId}`);
    return this.getDriver(account);
  }

  // ==================== 账号管理 ====================

  listAccounts() {
    return this.db.prepare('SELECT * FROM cloud_accounts ORDER BY created_at DESC').all();
  }

  getAccount(id) {
    return this.db.prepare('SELECT * FROM cloud_accounts WHERE id = ?').get(id);
  }

  createAccount(driver, name) {
    if (!DRIVERS[driver]) {
      throw new Error(`不支持的网盘类型: ${driver}，支持: ${Object.keys(DRIVERS).join(', ')}`);
    }
    const info = this.db.prepare(
      'INSERT INTO cloud_accounts (driver, name, status) VALUES (?, ?, ?)'
    ).run(driver, name, 'pending');
    return this.getAccount(info.lastInsertRowid);
  }

  /**
   * 创建网盘账号
   * 用户从浏览器复制 Cookie 粘贴到系统中
   * @param {string} driver - 驱动类型
   * @param {string} name - 账号名称
   * @param {string} cookie - 浏览器中的 Cookie 字符串
   * @returns {object} 账号信息
   */
  createAccountWithCookie(driver, name, cookie) {
    if (!DRIVERS[driver]) {
      throw new Error(`不支持的网盘类型: ${driver}，支持: ${Object.keys(DRIVERS).join(', ')}`);
    }
    if (!cookie || !cookie.trim()) {
      throw new Error('Cookie 不能为空');
    }

    const info = this.db.prepare(
      'INSERT INTO cloud_accounts (driver, name, access_token, status, token_expires_at) VALUES (?, ?, ?, ?, ?)'
    ).run(driver, name, cookie.trim(), 'active', new Date(Date.now() + 86400 * 30 * 1000).toISOString());

    const account = this.getAccount(info.lastInsertRowid);

    // 测试连接
    try {
      const driverInstance = this.getDriver(account);
      const userInfo = driverInstance.getUserInfo().catch(() => null);
      if (userInfo) {
        this.updateAccount(account.id, { user_info: JSON.stringify(userInfo) });
      }
    } catch (e) {
      // 连接测试失败不影响创建，用户可以后续修复
      console.warn('Cookie 登录连接测试失败:', e.message);
    }

    return this.getAccount(account.id);
  }

  updateAccount(id, updates) {
    const allowed = ['name', 'access_token', 'refresh_token', 'token_expires_at', 'user_info', 'status'];
    const sets = [];
    const values = [];
    for (const key of allowed) {
      if (updates[key] !== undefined) {
        sets.push(`${key} = ?`);
        values.push(updates[key]);
      }
    }
    if (sets.length === 0) return;
    sets.push('updated_at = CURRENT_TIMESTAMP');
    values.push(id);
    this.db.prepare(`UPDATE cloud_accounts SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  }

  deleteAccount(id) {
    // 删除关联的曲库和文件
    this.db.prepare('DELETE FROM cloud_files WHERE library_id IN (SELECT id FROM cloud_libraries WHERE account_id = ?)').run(id);
    this.db.prepare('DELETE FROM cloud_libraries WHERE account_id = ?').run(id);
    this.db.prepare('DELETE FROM cloud_accounts WHERE id = ?').run(id);
  }

  // ==================== 扫码登录 ====================

  /**
   * 开始扫码登录流程
   * @returns {Promise<{accountId: number, qrId: string, qrImage: string, expiresIn: number}>}
   */
  async startQRLogin(driver, name) {
    const account = this.createAccount(driver, name || `我的${driver}`);
    const driverInstance = this.getDriver(account);
    const qr = await driverInstance.getQRCode();

    // 保存扫码会话
    qrSessions.set(qr.qrId, {
      accountId: account.id,
      driver: driverInstance,
      createdAt: Date.now(),
      expiresAt: Date.now() + (qr.expiresIn || 180) * 1000,
    });

    return {
      accountId: account.id,
      qrId: qr.qrId,
      qrImage: qr.qrImage,
      expiresIn: qr.expiresIn || 180,
    };
  }

  /**
   * 轮询扫码状态
   */
  async checkQRLogin(qrId) {
    const session = qrSessions.get(qrId);
    if (!session) {
      return { status: 'expired', error: '扫码会话不存在或已过期' };
    }

    // 检查过期
    if (Date.now() > session.expiresAt) {
      qrSessions.delete(qrId);
      return { status: 'expired' };
    }

    const result = await session.driver.checkQRStatus(qrId);

    if (result.status === 'confirmed' && result.tokens) {
      // 登录成功，保存 token
      const userInfo = await session.driver.getUserInfo().catch(() => null);
      this.updateAccount(session.accountId, {
        access_token: result.tokens.access_token,
        refresh_token: result.tokens.refresh_token,
        token_expires_at: new Date(Date.now() + (result.tokens.expires_in || 86400 * 30) * 1000).toISOString(),
        user_info: JSON.stringify(userInfo),
        status: 'active',
      });
      qrSessions.delete(qrId);
      return { status: 'confirmed', accountId: session.accountId, userInfo };
    }

    return result;
  }

  // ==================== Token 刷新 ====================

  /**
   * 刷新所有过期/即将过期的 token
   * 由定时任务调用
   */
  async refreshAllTokens() {
    const accounts = this.db.prepare(
      "SELECT * FROM cloud_accounts WHERE status = 'active' AND token_expires_at IS NOT NULL"
    ).all();

    const now = Date.now();
    const results = [];

    for (const account of accounts) {
      try {
        const expiresAt = new Date(account.token_expires_at).getTime();
        // 提前 24 小时刷新
        if (expiresAt - now < 24 * 3600 * 1000) {
          const driver = this.getDriver(account);
          const tokens = await driver.refreshToken();
          this.updateAccount(account.id, {
            access_token: tokens.accessToken,
            refresh_token: tokens.refreshToken,
            token_expires_at: tokens.expiresAt.toISOString(),
          });
          results.push({ accountId: account.id, status: 'refreshed' });
        }
      } catch (e) {
        this.updateAccount(account.id, { status: 'error' });
        results.push({ accountId: account.id, status: 'error', error: e.message });
      }
    }

    return results;
  }

  // ==================== 曲库管理 ====================

  listLibraries() {
    return this.db.prepare(`
      SELECT cl.*, ca.name as account_name, ca.driver as account_driver
      FROM cloud_libraries cl
      LEFT JOIN cloud_accounts ca ON cl.account_id = ca.id
      ORDER BY cl.created_at DESC
    `).all();
  }

  addLibrary(accountId, mountPath, localName) {
    const info = this.db.prepare(
      'INSERT INTO cloud_libraries (account_id, mount_path, local_name) VALUES (?, ?, ?)'
    ).run(accountId, mountPath, localName);
    return info.lastInsertRowid;
  }

  deleteLibrary(id) {
    this.db.prepare('DELETE FROM cloud_files WHERE library_id = ?').run(id);
    this.db.prepare('DELETE FROM cloud_libraries WHERE id = ?').run(id);
  }

  updateLibraryScanStatus(id, status, songCount) {
    this.db.prepare(
      'UPDATE cloud_libraries SET scan_status = ?, last_scan_at = CURRENT_TIMESTAMP, song_count = ? WHERE id = ?'
    ).run(status, songCount || 0, id);
  }

  // ==================== 工具 ====================

  /**
   * 清理过期的扫码会话
   */
  cleanupExpiredSessions() {
    const now = Date.now();
    for (const [qrId, session] of qrSessions) {
      if (now > session.expiresAt) {
        qrSessions.delete(qrId);
      }
    }
  }

  /**
   * 获取支持的驱动列表
   */
  getSupportedDrivers() {
    return Object.entries(DRIVERS).map(([key, cls]) => ({
      type: key,
      name: key,
      authMethod: 'cookie',
    }));
  }
}

module.exports = CloudDriveManager;
