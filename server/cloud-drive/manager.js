/**
 * 网盘账号管理器
 *
 * 负责：账号增删改查、token 刷新、驱动实例化、扫码会话管理
 *
 * 多账号支持：
 *   - 同一驱动类型（如 pan115）可添加多个账号，按 name 区分
 *   - createAccountWithCookie 按 "driver + name" 去重：同名更新，不同名新增
 *   - listActiveAccounts() 返回所有 active 状态的账号，供扫描/串流遍历
 */



const fs = require('fs');

const path = require('path');

const Pan115Driver = require('./drivers/pan115');
const AliyunDriver = require('./drivers/aliyun');
const BaiduDriver = require('./drivers/baidu');
const XunleiDriver = require('./drivers/xunlei');
const CMCCDriver = require('./drivers/cmcc');
const QuarkDriver = require('./drivers/quark');
const AlistDriver = require('./drivers/alist');
// AList 自动挂载辅助（登录缓存 token / createStorage / deleteByPath / 驱动映射）
const alistMount = require('./alist-mount');

const DRIVERS = {
  pan115: Pan115Driver,
  aliyun: AliyunDriver,
  baidu: BaiduDriver,
  xunlei: XunleiDriver,
  cmcc: CMCCDriver,
  quark: QuarkDriver,
  alist: AlistDriver,
};



// 扫码会话内存缓存（重启后丢失，过期自动清理）

const qrSessions = new Map(); // qrId -> { accountId, driver, createdAt, expiresAt }



class CloudDriveManager {

  constructor(db) {

    this.db = db;

    this._initTables();

    // 启动后异步对账：补挂所有 active 但未记录 alist_storage_id 的账号（不阻塞构造）
    this.reconcileAlistMounts().catch(() => {});

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

    // 多账号支持：记录歌曲所属的云盘账号 ID
    try {

      this.db.exec("ALTER TABLE songs ADD COLUMN cloud_account_id INTEGER");

    } catch (e) { /* 已存在 */ }

    // AList 自动挂载：记录已创建的存储 id 与挂载路径（重复 ALTER 会抛错，忽略）
    try {

      this.db.exec("ALTER TABLE cloud_accounts ADD COLUMN alist_storage_id INTEGER");

    } catch (e) { /* 列已存在 */ }

    try {

      this.db.exec("ALTER TABLE cloud_accounts ADD COLUMN alist_mount_path TEXT");

    } catch (e) { /* 列已存在 */ }

    // 同网盘账号唯一标识：drive_type + 网盘用户ID，用于重新登录后自动归并旧账号的歌曲/来源
    try {

      this.db.exec("ALTER TABLE cloud_accounts ADD COLUMN driver_user_id TEXT");

    } catch (e) { /* 列已存在 */ }

  }



  // ==================== 驱动实例化 ====================



  getDriver(account) {

    const DriverClass = DRIVERS[account.driver];

    if (!DriverClass) {

      throw new Error(`未知网盘驱动类型: ${account.driver}`);

    }

    // 缓存驱动实例（单例），使驱动内部缓存（目录列表、直链等）跨请求持久化。
    // 移动云盘等API响应慢，若每次 new 实例则内部缓存全部失效，每首歌都要重新列目录。
    if (!this._driverCache) this._driverCache = new Map();

    const cached = this._driverCache.get(account.id);

    if (cached) return cached;

    const instance = new DriverClass(account);

    // P4: cmcc 驱动设置持久化 fid 缓存，并后台预加载目录列表
    if (account.driver === 'cmcc' && typeof instance.setFidCacheFile === 'function') {
      const dataDir = process.env.DATA_DIR || '/data';
      instance.setFidCacheFile(dataDir);
      // 后台预加载，不阻塞启动
      instance.preloadAll().catch(e => console.warn('[CMCC preload] 后台预加载失败:', e.message));
    }

    this._driverCache.set(account.id, instance);

    return instance;

  }



  /** 失效驱动单例缓存（token 更新/账号删除时调用） */

  invalidateDriver(accountId) {

    if (this._driverCache) this._driverCache.delete(accountId);

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



  /**
   * 列出所有 active 状态的账号（供扫描/串流遍历多账号使用）
   * @returns {Array} active 账号列表
   */
  listActiveAccounts() {
    return this.db.prepare(
      "SELECT * FROM cloud_accounts WHERE status = 'active' ORDER BY created_at ASC"
    ).all();
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
   * 创建网盘账号（支持多账号）
   * 用户从浏览器复制 Cookie 粘贴到系统中
   *
   * 多账号去重规则：按 "driver + name" 去重
   *   - 同一驱动 + 同一名称：更新已有账号
   *   - 同一驱动 + 不同名称：新增账号
   *   - 不同驱动：新增账号
   *
   * @param {string} driver - 驱动类型
   * @param {string} name - 账号名称（用于区分多账号）
   * @param {string} cookie - 浏览器中的 Cookie 字符串（或 token 类驱动的 access_token）
   * @param {string} [refreshToken] - 刷新令牌（token 类驱动使用，如阿里云盘/百度网盘）
   * @returns {object} 账号信息
   */

  async createAccountWithCookie(driver, name, cookie, refreshToken = null) {

    if (!DRIVERS[driver]) {

      throw new Error(`不支持的网盘类型: ${driver}，支持: ${Object.keys(DRIVERS).join(', ')}`);

    }

    if (!cookie || !cookie.trim()) {

      throw new Error('Cookie/Token 不能为空');

    }



    const cookieVal = cookie.trim();
    const refreshVal = refreshToken ? refreshToken.trim() : null;
    const expiresAt = new Date(Date.now() + 86400 * 30 * 1000).toISOString();

    // 多账号去重：按 "driver + name" 查找是否已存在
    // 同名同驱动则更新，否则新增
    const accountName = (name && name.trim()) ? name.trim() : `我的${driver}`;
    const existing = this.db.prepare(
      'SELECT id FROM cloud_accounts WHERE driver = ? AND name = ? ORDER BY id DESC LIMIT 1'
    ).get(driver, accountName);

    let accountId;
    if (existing) {
      if (refreshVal) {
        this.db.prepare(
          'UPDATE cloud_accounts SET access_token = ?, refresh_token = ?, status = ?, token_expires_at = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
        ).run(cookieVal, refreshVal, 'active', expiresAt, existing.id);
      } else {
        this.db.prepare(
          'UPDATE cloud_accounts SET access_token = ?, status = ?, token_expires_at = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
        ).run(cookieVal, 'active', expiresAt, existing.id);
      }
      accountId = existing.id;
      console.log(`[CloudDrive] 更新已有账号: ${accountName} (ID=${accountId}, driver=${driver})`);
    } else {
      if (refreshVal) {
        const info = this.db.prepare(
          'INSERT INTO cloud_accounts (driver, name, access_token, refresh_token, status, token_expires_at) VALUES (?, ?, ?, ?, ?, ?)'
        ).run(driver, accountName, cookieVal, refreshVal, 'active', expiresAt);
        accountId = info.lastInsertRowid;
      } else {
        const info = this.db.prepare(
          'INSERT INTO cloud_accounts (driver, name, access_token, status, token_expires_at) VALUES (?, ?, ?, ?, ?)'
        ).run(driver, accountName, cookieVal, 'active', expiresAt);
        accountId = info.lastInsertRowid;
      }
      console.log(`[CloudDrive] 新增账号: ${accountName} (ID=${accountId}, driver=${driver})`);
    }
    const account = this.getAccount(accountId);



    // 测试连接：成功 active，失败 error

    try {

      const driverInstance = this.getDriver(account);

      const tc = driverInstance.testConnection ? await driverInstance.testConnection() : { success: true };

      if (tc && tc.success) {

        const userInfo = await driverInstance.getUserInfo().catch(() => null);

        this.updateAccount(account.id, { status: 'active', user_info: JSON.stringify(userInfo) });

        // 记录网盘唯一用户标识，并按 drive+标识 自动归并同账号的旧记录（换号重新登录后歌曲/来源不丢）
        try {
          const driverUserId = (typeof driverInstance.getDriveUserId === 'function') ? driverInstance.getDriveUserId() : null;
          if (driverUserId) {
            this.updateAccount(account.id, { driver_user_id: String(driverUserId) });
            const dup = this.db.prepare('SELECT id FROM cloud_accounts WHERE driver = ? AND driver_user_id = ? AND id <> ? ORDER BY id ASC').get(driver, String(driverUserId), account.id);
            if (dup) this._mergeAccountInto(dup.id, account.id);
          }
        } catch (e) {
          console.warn('[CloudDrive] 同账号归并失败（忽略）:', e.message);
        }

      } else {

        this.updateAccount(account.id, { status: 'error' });

        console.warn('Cookie 登录连接测试失败:', (tc && tc.error) || 'unknown');

      }

    } catch (e) {

      this.updateAccount(account.id, { status: 'error' });

      console.warn('Cookie 登录连接测试失败:', e.message);

    }



    // 登录成功变 active 后自动挂载到内置 AList（await 但失败不影响返回）
    const finalAccount = this.getAccount(account.id);
    if (finalAccount && finalAccount.status === 'active') {
      await this._mountAccountSafe(finalAccount);
    }


    return this.getAccount(account.id);

  }



  updateAccount(id, updates) {

    const allowed = ['name', 'access_token', 'refresh_token', 'token_expires_at', 'user_info', 'status', 'driver_user_id'];

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

    this.invalidateDriver(id);

  }



  /**
   * 把旧账号 oldId 的全部数据归并到 newId，然后删除 oldId 账号行。
   * 场景：同一网盘账号重新登录后换了新 account_id，避免歌曲/曲库来源留在旧 id 上变成孤儿。
   * queue/history/favorites/song_artists 按 song_id 关联，歌曲换归属后自动跟随，无需改。
   */
  _mergeAccountInto(oldId, newId) {
    if (Number(oldId) === Number(newId)) return;
    const oldRow = this.getAccount(oldId);
    if (!oldRow) return;
    const tx = this.db.transaction(() => {
      this.db.prepare('UPDATE songs SET cloud_account_id = ? WHERE cloud_account_id = ?').run(newId, oldId);
      this.db.prepare('UPDATE cloud_libraries SET account_id = ? WHERE account_id = ?').run(newId, oldId);
      this._repointLibraryRootAccount(oldId, newId);
      this.db.prepare('DELETE FROM cloud_libraries WHERE account_id = ?').run(oldId);
      this.db.prepare('DELETE FROM cloud_accounts WHERE id = ?').run(oldId);
    });
    tx();
    this.invalidateDriver(oldId);
    console.log(`[CloudDrive] 同账号归并：旧账号 ${oldId} 已并入新账号 ${newId} 并删除旧记录`);
  }


  /**
   * 把 settings.library_roots 里 cloud.accountId === oldId 的来源指向改为 newId。
   */
  _repointLibraryRootAccount(oldId, newId) {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = 'library_roots'").get();
    if (!row || !row.value) return;
    let roots;
    try { roots = JSON.parse(row.value); } catch (e) { return; }
    if (!Array.isArray(roots)) return;
    let changed = false;
    for (const r of roots) {
      if (r && r.cloud && Number(r.cloud.accountId) === Number(oldId)) { r.cloud.accountId = Number(newId); changed = true; }
    }
    if (changed) {
      this.db.prepare("INSERT INTO settings (key, value) VALUES ('library_roots', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify(roots));
    }
  }

  async deleteAccount(id) {

    const acc = this.getAccount(id);
    if (!acc) {
      throw new Error(`网盘账号不存在: ${id}`);
    }

    // 5) AList 挂载存储卸载（await，确保删干净；best-effort，失败不阻断主流程）
    try {
      await alistMount.unmountAccount(acc);
    } catch (e) {
      console.warn('[AList] 删除前卸载失败（忽略）:', e.message);
    }

    // 1)+2) 主页"曲库来源与扫描" / admin"曲库源设置"共用的 library_roots 配置里，
    //       绑定到该账号（cloud.accountId === id）的来源条目一并移除。
    try {
      this._removeLibraryRootsForAccount(id);
    } catch (e) {
      console.warn('[删除账号] 清理曲库来源配置失败（忽略）:', e.message);
    }

    // 3)+4) 该账号在 songs 表下的所有歌曲记录，以及本地 /data/netseparated-strm 中
    //       这些歌曲引用到的 strm 文件。
    try {
      this._deleteSongsAndStrmForAccount(id);
    } catch (e) {
      console.warn('[删除账号] 清理歌曲/strm 失败（忽略）:', e.message);
    }

    // 删除关联的曲库和文件

    this.db.prepare('DELETE FROM cloud_files WHERE library_id IN (SELECT id FROM cloud_libraries WHERE account_id = ?)').run(id);

    this.db.prepare('DELETE FROM cloud_libraries WHERE account_id = ?').run(id);

    this.db.prepare('DELETE FROM cloud_accounts WHERE id = ?').run(id);

    this.invalidateDriver(id);

  }


  /**
   * 从 settings.library_roots 中移除所有 cloud.accountId === accountId 的曲库来源配置。
   * 主页"曲库来源与扫描"与 admin"曲库源设置"读的是同一份配置，这里清掉即两处同时生效。
   * 内置动态来源（cloud.accountId=0，或按当前 active 账号动态取）不会被误删。
   */
  _removeLibraryRootsForAccount(accountId) {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = 'library_roots'").get();
    if (!row || !row.value) return;
    let roots;
    try { roots = JSON.parse(row.value); } catch (e) { return; }
    if (!Array.isArray(roots)) return;
    const kept = roots.filter((r) => !(r && r.cloud && Number(r.cloud.accountId) === Number(accountId)));
    if (kept.length === roots.length) return;
    const removed = roots.length - kept.length;
    this.db.prepare(
      "INSERT INTO settings (key, value) VALUES ('library_roots', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
    ).run(JSON.stringify(kept));
    console.log(`[删除账号] 已从曲库来源配置移除 ${removed} 个绑定账号 ${accountId} 的来源`);
  }


  /**
   * 级联删除该账号在 songs 表下的全部歌曲记录，并删除这些歌曲引用到的本地 strm 文件。
   * 歌曲通过 cloud_account_id 归属；queue/history/favorites/song_artists 一并清。
   * strm 文件按歌曲行 filepath/vocal_path/accomp_path 指向 /data/netseparated-strm 的路径删除。
   */
  _deleteSongsAndStrmForAccount(accountId) {
    const DATA_DIR = process.env.DATA_DIR || '/data';
    const STRM_DIR = path.join(DATA_DIR, 'netseparated-strm');

    const songRows = this.db
      .prepare('SELECT filepath, vocal_path, accomp_path FROM songs WHERE cloud_account_id = ?')
      .all(accountId);

    let strmDeleted = 0;
    for (const s of songRows) {
      for (const p of [s.filepath, s.vocal_path, s.accomp_path]) {
        if (p && typeof p === 'string' && p.indexOf(STRM_DIR) === 0) {
          try { fs.rmSync(p, { force: true }); strmDeleted++; } catch (e) { /* 单个文件失败不阻断 */ }
        }
      }
    }

    const sub = 'SELECT id FROM songs WHERE cloud_account_id = ?';
    const del = this.db.transaction(() => {
      this.db.prepare(`DELETE FROM queue WHERE song_id IN (${sub})`).run(accountId);
      this.db.prepare(`DELETE FROM history WHERE song_id IN (${sub})`).run(accountId);
      this.db.prepare(`DELETE FROM favorites WHERE song_id IN (${sub})`).run(accountId);
      this.db.prepare(`DELETE FROM song_artists WHERE song_id IN (${sub})`).run(accountId);
      this.db.prepare('DELETE FROM songs WHERE cloud_account_id = ?').run(accountId);
    });
    del();
    console.log(`[删除账号] 已删除账号 ${accountId} 的歌曲 ${songRows.length} 首、本地 strm 文件 ${strmDeleted} 个`);
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

      // 先落盘 token，再实测连接；按测试结果决定 active / error

      this.updateAccount(session.accountId, {

        access_token: result.tokens.access_token || '',

        refresh_token: result.tokens.refresh_token || '',

        token_expires_at: new Date(Date.now() + (result.tokens.expires_in || 86400 * 30) * 1000).toISOString(),

        status: 'active',

      });

      const acc = this.getAccount(session.accountId);

      let liveUserInfo = null;

      let connOk = true;

      try {

        const di = this.getDriver(acc);

        const tc = di.testConnection ? await di.testConnection() : { success: true };

        connOk = !!(tc && tc.success);

        if (connOk) liveUserInfo = await di.getUserInfo().catch(() => null);

      } catch (e) {

        connOk = false;

        console.warn('[QRLogin] 连接测试失败:', e.message);

      }

      this.updateAccount(session.accountId, {

        status: connOk ? 'active' : 'error',

        user_info: JSON.stringify(liveUserInfo),

      });

      const userInfo = liveUserInfo;

      // 扫码登录成功且连接正常 -> 自动挂载到 AList
      if (connOk) {
        await this._mountAccountSafe(this.getAccount(session.accountId));
      }

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
    return [
      { type: 'pan115', name: '115网盘', authMethod: 'cookie', authHint: '填写浏览器中的 Cookie（UID+CID+SEID+KID）' },
      { type: 'aliyun', name: '阿里云盘', authMethod: 'token', authHint: '填写 access_token 和 refresh_token（Bearer 令牌）' },
      { type: 'baidu', name: '百度网盘', authMethod: 'token', authHint: '填写 OAuth access_token（可选 refresh_token）' },
      { type: 'xunlei', name: '迅雷云盘', authMethod: 'token', authHint: '填写 Bearer Token（从浏览器 Authorization 头提取）' },
      { type: 'cmcc', name: '移动云盘', authMethod: 'token', authHint: '填写 Authorization Token（Basic 后面的 base64 串，从 yun.139.com 请求头获取）' },
      { type: 'quark', name: '夸克网盘', authMethod: 'cookie', authHint: '支持扫码登录，或填写浏览器中的 Cookie（kpsdk_sid 等）' },
      { type: 'alist', name: 'Alist（统一网盘）', authMethod: 'token', authHint: '填写 Alist 地址和管理员账号（格式：URL|用户名|密码），可连接任意 Alist 实例（含 gbox）' },
    ];
  }

  // ==================== AList 自动挂载 ====================


  /**
   * 安全地为账号挂载到内置 AList（失败仅记录，不抛错）
   * 成功后回写 alist_storage_id / alist_mount_path
   */
  async _mountAccountSafe(account) {

    if (!account) return;

    try {
      const result = await alistMount.mountAccount(account);
      if (result && result.id != null) {
        this.db.prepare(
          'UPDATE cloud_accounts SET alist_storage_id = ?, alist_mount_path = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
        ).run(result.id, result.mountPath, account.id);
      }
    } catch (e) {
      console.error(`[AList] 自动挂载失败（账号 ${account.name}, driver=${account.driver}）:`, e.message);
    }

  }


  /**
   * 启动对账：把所有 active 但 alist_storage_id 为空的账号补挂一次（容错）
   */
  async reconcileAlistMounts(attempt = 1) {

    let hadLoadingError = false;
    try {
      const rows = this.db.prepare(
        "SELECT * FROM cloud_accounts WHERE status = 'active' AND (alist_storage_id IS NULL OR alist_storage_id = '') AND driver NOT IN ('xunlei', 'alist', 'aliyun', 'baidu')"
      ).all();

      for (const acc of rows) {
        try {
          await this._mountAccountSafe(acc);
        } catch (e) {
          console.warn('[AList] 对账挂载失败（忽略）:', acc.name, e.message);
          if (/Loading storage|Loading|登录失败|500/i.test(e.message)) hadLoadingError = true;
        }
      }

      const still = this.db.prepare(
        "SELECT COUNT(*) AS n FROM cloud_accounts WHERE status = 'active' AND (alist_storage_id IS NULL OR alist_storage_id = '') AND driver NOT IN ('xunlei', 'alist', 'aliyun', 'baidu')"
      ).get();
      if ((hadLoadingError || (still && still.n > 0)) && attempt < 6) {
        console.log(`[AList] 对账第 ${attempt} 轮后仍有 ${still ? still.n : 0} 个账号未挂载，10s 后重试...`);
        setTimeout(() => this.reconcileAlistMounts(attempt + 1).catch(() => {}), 10000);
      }
    } catch (e) {
      console.warn('[AList] 启动对账失败（忽略）:', e.message);
      if (attempt < 6) {
        setTimeout(() => this.reconcileAlistMounts(attempt + 1).catch(() => {}), 10000);
      }
    }

  }


}



module.exports = CloudDriveManager;
