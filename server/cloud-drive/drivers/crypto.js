/**
 * 115 网盘加密/解密算法
 * 参考开源项目 115drive-webdav (https://github.com/gaoyb7/115drive-webdav)
 *
 * 下载直链 API 使用 XOR + RSA 双层加密
 */

const crypto = require('crypto');

// XOR Key Seed (192 bytes)
const xorKeySeed = Buffer.from([
  0xf0, 0xe5, 0x69, 0xae, 0xbf, 0xdc, 0xbf, 0x8a,
  0x1a, 0x45, 0xe8, 0xbe, 0x7d, 0xa6, 0x73, 0xb8,
  0xde, 0x8f, 0xe7, 0xc4, 0x45, 0xda, 0x86, 0xc4,
  0x9b, 0x64, 0x8b, 0x14, 0x6a, 0xb4, 0xf1, 0xaa,
  0x38, 0x01, 0x35, 0x9e, 0x26, 0x69, 0x2c, 0x86,
  0x00, 0x6b, 0x4f, 0xa5, 0x36, 0x34, 0x62, 0xa6,
  0x2a, 0x96, 0x68, 0x18, 0xf2, 0x4a, 0xfd, 0xbd,
  0x6b, 0x97, 0x8f, 0x4d, 0x8f, 0x89, 0x13, 0xb7,
  0x6c, 0x8e, 0x93, 0xed, 0x0e, 0x0d, 0x48, 0x3e,
  0xd7, 0x2f, 0x88, 0xd8, 0xfe, 0xfe, 0x7e, 0x86,
  0x50, 0x95, 0x4f, 0xd1, 0xeb, 0x83, 0x26, 0x34,
  0xdb, 0x66, 0x7b, 0x9c, 0x7e, 0x9d, 0x7a, 0x81,
  0x32, 0xea, 0xb6, 0x33, 0xde, 0x3a, 0xa9, 0x59,
  0x34, 0x66, 0x3b, 0xaa, 0xba, 0x81, 0x60, 0x48,
  0xb9, 0xd5, 0x81, 0x9c, 0xf8, 0x6c, 0x84, 0x77,
  0xff, 0x54, 0x78, 0x26, 0x5f, 0xbe, 0xe8, 0x1e,
  0x36, 0x9f, 0x34, 0x80, 0x5c, 0x45, 0x2c, 0x9b,
  0x76, 0xd5, 0x1b, 0x8f, 0xcc, 0xc3, 0xb8, 0xf5,
]);

// XOR Client Key (12 bytes)
const xorClientKey = Buffer.from([
  0x78, 0x06, 0xad, 0x4c, 0x33, 0x86, 0x5d, 0x18,
  0x4c, 0x01, 0x3f, 0x46,
]);

// RSA Public Key
const rsaPublicKeyPem = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQCGhpgMD1okxLnUMCDNLCJwP/P0
UHVlKQWLHPiPCbhgITZHcZim4mgxSWWb0SLDNZL9ta1HlErR6k02xrFyqtYzjDu2
rGInUC0BCZOsln0a7wDwyOA43i5NO8LsNory6fEKbx7aT3Ji8TZCDAfDMbhxvxOf
dPMBDjxP5X3zr7cWgwIDAQAB
-----END PUBLIC KEY-----`;

// 解析 RSA 公钥获取 N 和 E
const rsaPublicKey = crypto.createPublicKey(rsaPublicKeyPem);
const rsaKeyData = rsaPublicKey.export({ type: 'pkcs1', format: 'jwk' });
const rsaN = BigInt('0x' + Buffer.from(rsaKeyData.n, 'base64').toString('hex'));
const rsaE = BigInt('0x' + Buffer.from(rsaKeyData.e, 'base64').toString('hex'));
const rsaKeySize = 128; // 1024 bits = 128 bytes

/**
 * 生成 16 字节随机 key
 */
function generateKey() {
  return crypto.randomBytes(16);
}

/**
 * 派生 XOR key
 * @param {Buffer} seed - 种子
 * @param {number} size - 派生 key 的大小
 */
function xorDeriveKey(seed, size) {
  const key = Buffer.alloc(size);
  for (let i = 0; i < size; i++) {
    key[i] = (seed[i] + xorKeySeed[size * i]) & 0xff;
    key[i] ^= xorKeySeed[size * (size - i - 1)];
  }
  return key;
}

/**
 * XOR 变换
 * @param {Buffer} data - 要变换的数据（原地修改）
 * @param {Buffer} key - XOR key
 */
function xorTransform(data, key) {
  const dataSize = data.length;
  const keySize = key.length;
  const mod = dataSize % 4;
  if (mod > 0) {
    for (let i = 0; i < mod; i++) {
      data[i] ^= key[i % keySize];
    }
  }
  for (let i = mod; i < dataSize; i++) {
    data[i] ^= key[(i - mod) % keySize];
  }
}

/**
 * 反转字节（原地修改）
 */
function reverseBytes(data) {
  for (let i = 0, j = data.length - 1; i < j; i++, j--) {
    const tmp = data[i];
    data[i] = data[j];
    data[j] = tmp;
  }
}

/**
 * RSA 加密（PKCS1v15）
 * @param {Buffer} input - 要加密的数据
 * @returns {Buffer} 加密后的数据
 */
function rsaEncrypt(input) {
  const plainSize = input.length;
  const blockSize = rsaKeySize - 11; // PKCS1v15  padding 需要 11 字节
  const blocks = [];

  for (let offset = 0; offset < plainSize; offset += blockSize) {
    let sliceSize = blockSize;
    if (offset + sliceSize > plainSize) {
      sliceSize = plainSize - offset;
    }
    const slice = input.slice(offset, offset + sliceSize);
    const encrypted = crypto.publicEncrypt(
      { key: rsaPublicKeyPem, padding: crypto.constants.RSA_PKCS1_PADDING },
      slice
    );
    blocks.push(encrypted);
  }

  return Buffer.concat(blocks);
}

/**
 * RSA 解密（使用公钥的 E 和 N，对应服务端用私钥加密的响应）
 * @param {Buffer} input - 要解密的数据
 * @returns {Buffer} 解密后的数据
 */
function rsaDecrypt(input) {
  const output = [];
  const cipherSize = input.length;
  const blockSize = rsaKeySize;

  for (let offset = 0; offset < cipherSize; offset += blockSize) {
    let sliceSize = blockSize;
    if (offset + sliceSize > cipherSize) {
      sliceSize = cipherSize - offset;
    }
    const slice = input.slice(offset, offset + sliceSize);

    // m = c^e mod n
    const c = BigInt('0x' + slice.toString('hex'));
    const m = modPow(c, rsaE, rsaN);
    const b = Buffer.from(m.toString(16).padStart(256, '0'), 'hex');

    // PKCS1v15 解密：找到第一个 0x00 字节，后面的就是明文
    const index = b.indexOf(0x00, 2); // 跳过 0x00 0x02 开头
    if (index < 0) {
      return null;
    }
    output.push(b.slice(index + 1));
  }

  return Buffer.concat(output);
}

/**
 * 模幂运算 (base^exponent mod modulus)
 */
function modPow(base, exponent, modulus) {
  let result = 1n;
  base = base % modulus;
  while (exponent > 0n) {
    if (exponent % 2n === 1n) {
      result = (result * base) % modulus;
    }
    exponent = exponent >> 1n;
    base = (base * base) % modulus;
  }
  return result;
}

/**
 * 加密
 * @param {Buffer|string} input - 要加密的数据
 * @param {Buffer} key - 16 字节随机 key
 * @returns {string} Base64 编码的加密结果
 */
function encode(input, key) {
  if (typeof input === 'string') {
    input = Buffer.from(input);
  }

  // 构造缓冲区：key(16字节) + 输入数据
  const buf = Buffer.alloc(16 + input.length);
  key.copy(buf, 0);
  input.copy(buf, 16);

  // 对输入数据部分进行 XOR 变换（使用派生 key，size=4）
  const dataPart = buf.slice(16);
  xorTransform(dataPart, xorDeriveKey(key, 4));

  // 反转字节
  reverseBytes(dataPart);

  // 再次 XOR 变换（使用固定的 xorClientKey）
  xorTransform(dataPart, xorClientKey);

  // RSA 加密 + Base64 编码
  const encrypted = rsaEncrypt(buf);
  return encrypted.toString('base64');
}

/**
 * 解密
 * @param {string} input - Base64 编码的加密数据
 * @param {Buffer} key - 加密时使用的 16 字节 key
 * @returns {Buffer} 解密后的数据
 */
function decode(input, key) {
  // Base64 解码
  const data = Buffer.from(input, 'base64');

  // RSA 解密
  const decrypted = rsaDecrypt(data);
  if (!decrypted) {
    throw new Error('RSA 解密失败');
  }

  // 提取 key（前16字节）和数据
  const dataKey = decrypted.slice(0, 16);
  const output = Buffer.from(decrypted.slice(16));

  // XOR 变换（使用数据中的 key 派生，size=12）
  xorTransform(output, xorDeriveKey(dataKey, 12));

  // 反转字节
  reverseBytes(output);

  // 再次 XOR 变换（使用传入的 key 派生，size=4）
  xorTransform(output, xorDeriveKey(key, 4));

  return output;
}

module.exports = {
  generateKey,
  encode,
  decode,
  xorDeriveKey,
  xorTransform,
  reverseBytes,
  rsaEncrypt,
  rsaDecrypt,
};
