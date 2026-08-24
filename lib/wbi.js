// B站字幕 AI 助手 - lib/wbi.js
// 纯函数库：MD5（RFC1321 表格驱动）、B站 wbi 签名、字幕时间/行归一化。
// 同时兼容：importScripts 全局加载（扩展 SW）与 node require（单元测试）。
(function (global) {
  "use strict";

  // ---------------- MD5（RFC 1321） ----------------
  function utf8Bytes(str) {
    const out = [];
    for (let i = 0; i < str.length; i++) {
      const c = str.charCodeAt(i);
      if (c < 0x80) {
        out.push(c);
        continue;
      }
      if (c < 0x800) {
        out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
        continue;
      }
      if (c >= 0xd800 && c <= 0xdbff && i + 1 < str.length) {
        const c2 = str.charCodeAt(i + 1);
        if (c2 >= 0xdc00 && c2 <= 0xdfff) {
          const cp = 0x10000 + ((c - 0xd800) << 10) + (c2 - 0xdc00);
          out.push(
            0xf0 | (cp >> 18),
            0x80 | ((cp >> 12) & 0x3f),
            0x80 | ((cp >> 6) & 0x3f),
            0x80 | (cp & 0x3f)
          );
          i++;
          continue;
        }
      }
      out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    }
    return out;
  }

  // RFC 1321 的 64 个常量 K[i] = floor(abs(sin(i+1)) * 2^32)
  const MD5_K = [
    0xd76aa478, 0xe8c7b756, 0x242070db, 0xc1bdceee, 0xf57c0faf, 0x4787c62a, 0xa8304613, 0xfd469501,
    0x698098d8, 0x8b44f7af, 0xffff5bb1, 0x895cd7be, 0x6b901122, 0xfd987193, 0xa679438e, 0x49b40821,
    0xf61e2562, 0xc040b340, 0x265e5a51, 0xe9b6c7aa, 0xd62f105d, 0x02441453, 0xd8a1e681, 0xe7d3fbc8,
    0x21e1cde6, 0xc33707d6, 0xf4d50d87, 0x455a14ed, 0xa9e3e905, 0xfcefa3f8, 0x676f02d9, 0x8d2a4c8a,
    0xfffa3942, 0x8771f681, 0x6d9d6122, 0xfde5380c, 0xa4beea44, 0x4bdecfa9, 0xf6bb4b60, 0xbebfbc70,
    0x289b7ec6, 0xeaa127fa, 0xd4ef3085, 0x04881d05, 0xd9d4d039, 0xe6db99e5, 0x1fa27cf8, 0xc4ac5665,
    0xf4292244, 0x432aff97, 0xab9423a7, 0xfc93a039, 0x655b59c3, 0x8f0ccc92, 0xffeff47d, 0x85845dd1,
    0x6fa87e4f, 0xfe2ce6e0, 0xa3014314, 0x4e0811a1, 0xf7537e82, 0xbd3af235, 0x2ad7d2bb, 0xeb86d391
  ];
  // 每轮左移位数：轮1 [7,12,17,22]，轮2 [5,9,14,20]，轮3 [4,11,16,23]，轮4 [6,10,15,21]
  const MD5_SHIFTS = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];

  function safeAdd(x, y) {
    const lsw = (x & 0xffff) + (y & 0xffff);
    const msw = (x >> 16) + (y >> 16) + (lsw >> 16);
    return (msw << 16) | (lsw & 0xffff);
  }
  function bitRotateLeft(num, cnt) {
    return (num << cnt) | (num >>> (32 - cnt));
  }

  function bytesToBinl(bytes) {
    const bin = [];
    for (let i = 0; i < bytes.length; i++) {
      bin[i >> 2] |= bytes[i] << ((i % 4) * 8);
    }
    return bin;
  }

  function binl2hex(binarray) {
    const hexTab = "0123456789abcdef";
    let str = "";
    for (let i = 0; i < binarray.length * 4; i++) {
      str += hexTab.charAt((binarray[i >> 2] >> ((i % 4) * 8 + 4)) & 0xf) +
        hexTab.charAt((binarray[i >> 2] >> ((i % 4) * 8)) & 0xf);
    }
    return str;
  }

  function md5(str) {
    const bytes = utf8Bytes(String(str));
    const bitLen = bytes.length * 8;
    const x = bytesToBinl(bytes);
    // 消息填充：补 0x80，再补长度
    x[bitLen >> 5] |= 0x80 << (bitLen % 32);
    x[(((bitLen + 64) >>> 9) << 4) + 14] = bitLen;
    const need = Math.ceil((x.length + 1) / 16) * 16;
    while (x.length < need) x.push(0);

    let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
    for (let i = 0; i < x.length; i += 16) {
      const m = x.slice(i, i + 16);
      let A = a0, B = b0, C = c0, D = d0;
      for (let j = 0; j < 64; j++) {
        let F, g;
        if (j < 16) { F = (B & C) | (~B & D); g = j; }
        else if (j < 32) { F = (D & B) | (~D & C); g = (5 * j + 1) % 16; }
        else if (j < 48) { F = B ^ C ^ D; g = (3 * j + 5) % 16; }
        else { F = C ^ (B | ~D); g = (7 * j) % 16; }
        const shift = MD5_SHIFTS[((j >> 4) << 2) + (j % 4)];
        F = safeAdd(safeAdd(safeAdd(A, F), MD5_K[j]), m[g]);
        const tmp = D;
        D = C; C = B;
        B = safeAdd(B, bitRotateLeft(F, shift));
        A = tmp;
      }
      a0 = safeAdd(a0, A); b0 = safeAdd(b0, B);
      c0 = safeAdd(c0, C); d0 = safeAdd(d0, D);
    }
    return binl2hex([a0, b0, c0, d0]);
  }

  // ---------------- wbi 签名 ----------------
  const MIXIN_KEY_ENC_TAB = [
    46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35,
    27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13,
    37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4,
    22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52
  ];

  // orig = imgKey + subKey（共 64 字符），按表重排取前 32 字符
  function getMixinKey(orig) {
    let s = "";
    for (const i of MIXIN_KEY_ENC_TAB) s += orig[i];
    return s.slice(0, 32);
  }

  // 从 wbi_img 的图片 URL 提取 32 位 key
  function keyFromUrl(url) {
    const name = url.slice(url.lastIndexOf("/") + 1).split(".")[0];
    return name.slice(0, 32);
  }

  // params: 普通参数对象（不含 wts/w_rid）。返回可直接拼到 URL 的 query 字符串。
  function encWbi(params, imgKey, subKey) {
    const mixinKey = getMixinKey(imgKey + subKey);
    const wts = Math.round(Date.now() / 1000);
    const merged = Object.assign({}, params, { wts });
    const query = Object.keys(merged)
      .sort()
      .filter(k => String(merged[k]) !== "")
      .map(k => k + "=" + encodeURIComponent(String(merged[k])))
      .join("&");
    const wRid = md5(query + mixinKey);
    return query + "&w_rid=" + wRid;
  }

  // ---------------- 字幕解析 ----------------
  function parseTs(ts) {
    const p = String(ts).trim().split(":");
    let sec = 0;
    for (const part of p) sec = sec * 60 + parseFloat(part);
    return sec;
  }

  // B站字幕 JSON body -> [{start,end,text}]
  function normalizeBody(body) {
    return (body || [])
      .map(it => ({
        start: parseTs(it.from ?? it.start ?? 0),
        end: parseTs(it.to ?? it.end ?? 0),
        text: (it.content ?? it.text ?? "").trim()
      }))
      .filter(it => it.text.length > 0);
  }

  const api = { md5, getMixinKey, keyFromUrl, encWbi, parseTs, normalizeBody, MIXIN_KEY_ENC_TAB };
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    global.BiliLib = api;
  }
})(typeof self !== "undefined" ? self : this);
