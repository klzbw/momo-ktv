/**
 * AList 自动挂载辅助模块
 *
 * 封装对内置 AList（http://127.0.0.1:5234）admin API 的调用：
 *   - 登录取 token 并缓存（47 小时），401 时自动重新登录
 *   - createStorage / enable / deleteByPath / listStorages
 *   - 按 momo 的 driver 类型映射到 AList driver 与 addition
 *
 * 仅使用 Node 内置 http 模块，不引入新依赖。
 * 所有失败都通过 console.warn/error 记录，不抛异常，避免影响主流程。
 */

const http = require('http');

// ===== AList 连接配置 =====
const ALIST_HOST = process.env.ALIST_HOST || '127.0.0.1';
const ALIST_PORT = parseInt(process.env.ALIST_PORT || '5234', 10);
const ALIST_USER = process.env.ALIST_USER || 'admin';
const ALIST_PASS = process.env.ALIST_PASSWORD || 'admin123';

// token 缓存（47 小时，AList 默认 token 有效期 48 小时，提前 1 小时刷新）
let _cachedToken = null;
let _tokenExpireAt = 0;
const TOKEN_TTL = 47 * 3600 * 1000;

/**
 * 驱动映射表：momo driver -> { alistDriver, webdavPolicy, buildAddition }
 *   - buildAddition(account) 返回 addition 对象，调用方负责 JSON.stringify
 */
const DRIVER_MAP = {
  // 115 网盘：access_token 本身就是 "UID=..; CID=..; SEID=..; KID=.." 格式
  pan115: {
    alistDriver: '115 Cloud',
    webdavPolicy: '302_redirect',
    buildAddition(account) {
      return {
        cookie: account.access_token || '',
        root_folder_id: '0',
        page_size: 1000,
      };
    },
  },
  // 夸克网盘
  quark: {
    alistDriver: 'Quark',
    webdavPolicy: 'native_proxy',
    buildAddition(account) {
      return {
        cookie: account.access_token || '',
        root_folder_id: '0',
      };
    },
  },
  // UC 网盘
  uc: {
    alistDriver: 'UC',
    webdavPolicy: 'native_proxy',
    buildAddition(account) {
      return {
        cookie: account.access_token || '',
        root_folder_id: '0',
      };
    },
  },
  // 移动云盘（139）：access_token 是 Basic token，只能填 authorization
  cmcc: {
    alistDriver: '139Yun',
    webdavPolicy: '302_redirect',
    buildAddition(account) {
      return {
        authorization: account.access_token || '',
        username: '',
        password: '',
        mail_cookies: '',
        root_folder_id: '',
        type: 'personal_new',
      };
    },
  },
  // 百度网盘：走 refresh_token
  baidu: {
    alistDriver: 'BaiduNetdisk',
    webdavPolicy: '302_redirect',
    buildAddition(account) {
      return {
        refresh_token: account.refresh_token || '',
        root_folder_path: '/',
        client_id: 'iYCeC9g08h5vuP9UqvPHKKSVrKFXGa1v',
        client_secret: 'jXiFMOPVPCWlO2M5CwWQzffpNPaGTRBG',
        custom_crack_ua: 'netdisk',
      };
    },
  },
  // 阿里云盘：走 refresh_token
  aliyun: {
    alistDriver: 'AliyundriveOpen',
    webdavPolicy: '302_redirect',
    buildAddition(account) {
      return {
        refresh_token: account.refresh_token || '',
        root_folder_id: 'root',
        drive_type: 'default',
        oauth_token_url: 'https://api.nn.ci/alist/ali_open/token',
      };
    },
  },
  // 迅雷：该驱动只接受 username/password，momo 只存 Bearer token，无法映射 -> 跳过
  // alist（连接外部 alist）：不需要自动挂载
};

/** 计算挂载路径：/云盘/{driver}/{name} */
function buildMountPath(account) {
  return `/云盘/${account.driver}/${account.name}`;
}

/** 发送一个 HTTP 请求（JSON），返回解析后的 JSON 对象 */
function request(method, pathName, { body, query, token } = {}) {
  return new Promise((resolve, reject) => {
    let pathStr = pathName;
    if (query) {
      const qs = new URLSearchParams(query).toString();
      pathStr += (pathName.includes('?') ? '&' : '?') + qs;
    }
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = token;
    const payload = body ? JSON.stringify(body) : null;
    if (payload) headers['Content-Length'] = Buffer.byteLength(payload);

    const req = http.request(
      { host: ALIST_HOST, port: ALIST_PORT, path: pathStr, method, headers },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          try {
            const json = data ? JSON.parse(data) : {};
            resolve({ statusCode: res.statusCode, json });
          } catch (e) {
            reject(new Error(`AList 响应解析失败: ${e.message}, body=${data.slice(0, 200)}`));
          }
        });
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/** 登录取 token，带缓存；返回 token 字符串，失败抛错 */
async function login() {
  if (_cachedToken && Date.now() < _tokenExpireAt) return _cachedToken;
  const { json } = await request('POST', '/api/auth/login', {
    body: { username: ALIST_USER, password: ALIST_PASS },
  });
  if (!json || json.code !== 200 || !json.data || !json.data.token) {
    throw new Error(`AList 登录失败: ${JSON.stringify(json).slice(0, 200)}`);
  }
  _cachedToken = json.data.token;
  _tokenExpireAt = Date.now() + TOKEN_TTL;
  return _cachedToken;
}

/** 带 401 重试的 API 调用 */
async function apiWithAuth(method, pathName, opts = {}) {
  let token = await login();
  let resp = await request(method, pathName, { ...opts, token });
  // 401：token 失效，强制重新登录后重试一次
  if (resp.statusCode === 401 || (resp.json && resp.json.code === 401)) {
    _cachedToken = null;
    token = await login();
    resp = await request(method, pathName, { ...opts, token });
  }
  return resp;
}

/** 列出所有存储 */
async function listStorages() {
  const { json } = await apiWithAuth('GET', '/api/admin/storage/list');
  if (!json || json.code !== 200) {
    throw new Error(`AList 列存储失败: ${JSON.stringify(json).slice(0, 200)}`);
  }
  return (json.data && json.data.content) || [];
}

/** 创建存储，返回 { id, mountPath } */
async function createStorage(account) {
  const mapping = DRIVER_MAP[account.driver];
  if (!mapping) {
    throw new Error(`不支持的 driver 映射: ${account.driver}`);
  }
  const mountPath = buildMountPath(account);
  const addition = JSON.stringify(mapping.buildAddition(account));

  const body = {
    mount_path: mountPath,
    order: 0,
    driver: mapping.alistDriver,
    cache_expiration: 30,
    status: 'work',
    webdav_policy: mapping.webdavPolicy,
    addition,
  };

  const { json } = await apiWithAuth('POST', '/api/admin/storage/create', { body });
  if (!json || json.code !== 200) {
    throw new Error(`AList 创建存储失败: ${JSON.stringify(json).slice(0, 200)}`);
  }
  const id = json.data && json.data.id;
  // 创建后默认已启用，enable 仅作 Loading 兜底；忽略"已启用"错误
  if (id != null) {
    try {
      await apiWithAuth('POST', '/api/admin/storage/enable', { query: { id } });
    } catch (e) {
      console.warn(`[AList] enable 存储 id=${id} 失败（可忽略）:`, e.message);
    }
  }
  return { id, mountPath };
}

/** 按 id 删除存储（必须用 query 参数 ?id=N） */
async function deleteStorageById(id) {
  if (id == null) return false;
  const { json } = await apiWithAuth('POST', '/api/admin/storage/delete', { query: { id } });
  if (!json || json.code !== 200) {
    throw new Error(`AList 删除存储 id=${id} 失败: ${JSON.stringify(json).slice(0, 200)}`);
  }
  return true;
}

/** 按 mount_path 反查并删除存储 */
async function deleteStorageByPath(mountPath) {
  const list = await listStorages();
  const target = list.find((s) => s.mount_path === mountPath);
  if (!target) return false;
  return deleteStorageById(target.id);
}

/**
 * 为一个账号执行自动挂载（幂等）。
 *  - xunlei / alist 驱动：明确跳过并 warn
 *  - 挂载前先 list，若已有相同 mount_path：视为已挂载，返回其 id（不重复创建）
 *  - 成功返回 { id, mountPath, created }；跳过返回 null；失败抛错
 *
 * @param {object} account - cloud_accounts 行
 */
async function mountAccount(account) {
  if (!account) return null;

  // 显式跳过的驱动
  if (account.driver === 'xunlei') {
    console.warn(`[AList] 跳过 xunlei 账号 "${account.name}"：Thunder 驱动需要用户名密码，无法用 Bearer token 自动挂载。`);
    return null;
  }
  if (account.driver === 'aliyun') {
    console.warn(`[AList] 跳过 aliyun 账号 "${account.name}"：阿里云 token 走 gbox 私有 OAuth，AList 公共驱动不认，仅走 cloud-drive 驱动。`);
    return null;
  }
  if (account.driver === 'baidu') {
    console.warn(`[AList] 跳过 baidu 账号 "${account.name}"：百度 token 走 gbox 私有 OAuth，AList 公共驱动不认，仅走 cloud-drive 驱动。`);
    return null;
  }
  if (account.driver === 'alist') {
    console.warn(`[AList] 跳过 alist 外部连接账号 "${account.name}"：该类型不自动挂载。`);
    return null;
  }
  if (!DRIVER_MAP[account.driver]) {
    console.warn(`[AList] 跳过未知 driver="${account.driver}" 的账号 "${account.name}"：无映射。`);
    return null;
  }

  const mountPath = buildMountPath(account);

  // 幂等：先列存储，若已有相同 mount_path 则跳过
  const list = await listStorages();
  const existing = list.find((s) => s.mount_path === mountPath);
  if (existing) {
    console.log(`[AList] 存储已存在: ${mountPath} (id=${existing.id})，跳过创建。`);
    return { id: existing.id, mountPath, created: false };
  }

  const result = await createStorage(account);
  console.log(`[AList] 挂载成功: ${mountPath} (id=${result.id}, driver=${account.driver})`);
  return { id: result.id, mountPath: result.mountPath, created: true };
}

/**
 * 删除一个账号对应的 AList 存储。
 * 优先按 alist_storage_id 删；为空则按 mount_path 反查再删。
 * 失败只 warn，不抛错。
 *
 * @param {object} account - cloud_accounts 行
 */
async function unmountAccount(account) {
  if (!account) return;
  try {
    if (account.alist_storage_id != null) {
      await deleteStorageById(account.alist_storage_id);
      console.log(`[AList] 已删除存储 id=${account.alist_storage_id}（账号 ${account.name}）`);
      return;
    }
    // 没有记录 id，按 mount_path 反查
    const mountPath = account.alist_mount_path || buildMountPath(account);
    await deleteStorageByPath(mountPath);
    console.log(`[AList] 已按路径删除存储 ${mountPath}（账号 ${account.name}）`);
  } catch (e) {
    console.warn(`[AList] 删除存储失败（忽略，不阻断）:`, e.message);
  }
}

module.exports = {
  mountAccount,
  unmountAccount,
  listStorages,
  buildMountPath,
  DRIVER_MAP,
};
