/**
 * 网盘驱动基类
 * 定义统一接口，各网盘驱动（115/阿里云盘/WebDAV）继承此类并实现具体方法。
 *
 * 设计原则：
 * 1. 所有异步方法返回 Promise
 * 2. 文件路径统一用 POSIX 风格（/ 分隔）
 * 3. 错误统一抛出 Error，包含 code 和 message
 * 4. token 刷新由 manager.js 统一调度，驱动只负责实现 refreshToken
 */

class CloudDriveBase {
  constructor(account) {
    this.account = account; // cloud_accounts 表的一行记录
    this.accessToken = account.access_token;
    this.refreshToken = account.refresh_token;
  }

  // ==================== 认证相关 ====================

  /**
   * 获取登录二维码
   * @returns {Promise<{qrId: string, qrImage: string, expiresIn: number}>}
   *   qrImage 是 base64 编码的 PNG 图片，前端直接 <img src="data:image/png;base64,...">
   */
  async getQRCode() {
    throw new Error('getQRCode not implemented');
  }

  /**
   * 轮询扫码状态
   * @param {string} qrId - getQRCode 返回的 qrId
   * @returns {Promise<{status: 'waiting'|'scanned'|'confirmed'|'expired', tokens?: object}>}
   *   confirmed 时返回 tokens（access_token/refresh_token/expires_in）
   */
  async checkQRStatus(qrId) {
    throw new Error('checkQRStatus not implemented');
  }

  /**
   * 刷新 access_token
   * @returns {Promise<{accessToken: string, refreshToken: string, expiresAt: Date}>}
   */
  async refreshToken() {
    throw new Error('refreshToken not implemented');
  }

  // ==================== 文件操作 ====================

  /**
   * 列出目录下的文件和子目录
   * @param {string} remotePath - 网盘内路径，如 /KTV/华语
   * @returns {Promise<Array<{
   *   fileId: string, name: string, path: string,
   *   isDir: boolean, size: number, modifiedAt: Date,
   *   pickCode?: string  // 115 专用，用于获取下载直链
   * }>>}
   */
  async listFiles(remotePath) {
    throw new Error('listFiles not implemented');
  }

  /**
   * 获取文件详情
   * @param {string} fileId
   * @returns {Promise<object>}
   */
  async getFileInfo(fileId) {
    throw new Error('getFileInfo not implemented');
  }

  /**
   * 获取下载直链（支持 Range 请求）
   * @param {string} fileId - 文件ID 或 pickCode
   * @returns {Promise<{url: string, expiresAt: Date}>}
   */
  async getDownloadUrl(fileId) {
    throw new Error('getDownloadUrl not implemented');
  }

  // ==================== 上传相关（人声分离云同步用） ====================

  /**
   * 创建目录（递归）
   * @param {string} remotePath
   * @returns {Promise<string>} 返回目录的 fileId
   */
  async mkdir(remotePath) {
    throw new Error('mkdir not implemented');
  }

  /**
   * 上传文件
   * @param {string} localPath - 本地文件路径
   * @param {string} remotePath - 网盘目标路径（含文件名）
   * @param {function} [onProgress] - 进度回调 (uploaded, total) => void
   * @returns {Promise<{fileId: string, path: string}>}
   */
  async uploadFile(localPath, remotePath, onProgress) {
    throw new Error('uploadFile not implemented');
  }

  // ==================== 工具方法 ====================

  /**
   * 获取用户信息（昵称、容量等）
   * @returns {Promise<{nickname: string, totalSize: number, usedSize: number, avatar?: string}>}
   */
  async getUserInfo() {
    throw new Error('getUserInfo not implemented');
  }

  /**
   * 测试连接是否正常
   * @returns {Promise<boolean>}
   */
  async testConnection() {
    try {
      await this.getUserInfo();
      return true;
    } catch (e) {
      return false;
    }
  }

  // ==================== 内部工具 ====================

  /**
   * 标准化路径：确保以 / 开头，去除末尾 /
   */
  _normalizePath(p) {
    if (!p) return '/';
    p = p.replace(/\\/g, '/');
    if (!p.startsWith('/')) p = '/' + p;
    if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
    return p;
  }

  /**
   * 拼接路径
   */
  _joinPath(...parts) {
    return this._normalizePath(parts.join('/'));
  }
}

module.exports = CloudDriveBase;
