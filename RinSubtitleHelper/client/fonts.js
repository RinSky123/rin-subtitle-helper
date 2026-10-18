/* ==================================================================
 *  fonts.js — 扫描系统已安装字体，解析出 AE 需要的 PostScript 字体名
 *
 *  AE 的 TextDocument.font 接受的是字体的 PostScript 名（name 表 nameID=6），
 *  而不是文件名、也不是中文显示名。所以这里直接解析字体二进制的 name 表。
 *
 *  支持：TTF / OTF / TTC(字体集合)
 * ================================================================== */
var fs = require("fs");
var path = require("path");

/* ---------- UTF-16BE -> JS 字符串 ---------- */
function decodeUTF16BE(buf, start, len) {
  var s = "";
  for (var i = 0; i + 1 < len; i += 2) {
    s += String.fromCharCode((buf[start + i] << 8) | buf[start + i + 1]);
  }
  return s;
}

function decodeLatin1(buf, start, len) {
  return buf.toString("latin1", start, start + len);
}

/** 取出这个字体（相对整个文件偏移 fontOffset 的 offset table）的 name 表信息 */
function readNames(buf, fontOffset) {
  if (fontOffset + 12 > buf.length) return null;
  var numTables = buf.readUInt16BE(fontOffset + 4);
  var nameOff = -1;
  for (var i = 0; i < numTables; i++) {
    var rec = fontOffset + 12 + i * 16;
    if (rec + 16 > buf.length) break;
    var tag = buf.toString("latin1", rec, rec + 4);
    if (tag === "name") { nameOff = buf.readUInt32BE(rec + 8); break; }
  }
  if (nameOff < 0 || nameOff + 6 > buf.length) return null;

  var count = buf.readUInt16BE(nameOff + 2);
  var strBase = nameOff + buf.readUInt16BE(nameOff + 4);

  var res = { ps: null, full: null, family: null };
  var best = {}; // nameID -> 权重

  for (var j = 0; j < count; j++) {
    var r = nameOff + 6 + j * 12;
    if (r + 12 > buf.length) break;
    var platformID = buf.readUInt16BE(r);
    var encodingID = buf.readUInt16BE(r + 2);
    var languageID = buf.readUInt16BE(r + 4);
    var nameID = buf.readUInt16BE(r + 6);
    var length = buf.readUInt16BE(r + 8);
    var offset = buf.readUInt16BE(r + 10);

    if (nameID !== 1 && nameID !== 4 && nameID !== 6) continue;
    var start = strBase + offset;
    if (start + length > buf.length) continue;

    var text;
    if (platformID === 3 || platformID === 0) text = decodeUTF16BE(buf, start, length);
    else text = decodeLatin1(buf, start, length);

    // 权重：Windows + 英文(0x409) 最优先
    var w = 0;
    if (platformID === 3) w += 4;
    if (languageID === 0x409) w += 2;
    if (encodingID === 1) w += 1;

    var key = nameID === 1 ? "family" : (nameID === 4 ? "full" : "ps");
    if (best[key] === undefined || w > best[key]) {
      best[key] = w;
      res[key] = text;
    }
  }
  return res;
}

/** 扫描单个字体文件，返回 [{ps, family, full}] */
function scanFile(file) {
  var out = [];
  var buf;
  try { buf = fs.readFileSync(file); } catch (e) { return out; }
  if (buf.length < 12) return out;

  var tag = buf.toString("latin1", 0, 4);
  if (tag === "ttcf") {
    // 字体集合：多个字体共享一个文件
    var numFonts = buf.readUInt32BE(8);
    for (var i = 0; i < numFonts; i++) {
      var p = 12 + i * 4;
      if (p + 4 > buf.length) break;
      var off = buf.readUInt32BE(p);
      var n = readNames(buf, off);
      if (n && (n.ps || n.full || n.family)) out.push(n);
    }
  } else {
    var n2 = readNames(buf, 0);
    if (n2 && (n2.ps || n2.full || n2.family)) out.push(n2);
  }
  return out;
}

/** 列出某目录下的字体 */
function scanDir(dir, seen, out) {
  if (!dir) return;
  var names;
  try { names = fs.readdirSync(dir); } catch (e) { return; }
  for (var i = 0; i < names.length; i++) {
    var f = names[i];
    if (!/\.(ttf|otf|ttc|otc)$/i.test(f)) continue;
    var full = path.join(dir, f);
    var fonts = scanFile(full);
    for (var k = 0; k < fonts.length; k++) {
      var fo = fonts[k];
      var ps = fo.ps || fo.full || fo.family;
      if (!ps) continue;
      if (seen[ps]) continue;
      seen[ps] = true;
      out.push({
        ps: ps,                              // AE 用的 PostScript 名
        family: fo.family || fo.full || ps,  // 显示用
        file: f
      });
    }
  }
}

/** 主入口：返回去重后的字体数组 */
function listFonts() {
  var out = [];
  var seen = {};
  var dirs = [];
  var win = process.env.WINDIR || "C:\\Windows";
  dirs.push(path.join(win, "Fonts"));
  if (process.env.LOCALAPPDATA) {
    dirs.push(path.join(process.env.LOCALAPPDATA, "Microsoft", "Windows", "Fonts"));
  }
  for (var i = 0; i < dirs.length; i++) scanDir(dirs[i], seen, out);
  out.sort(function (a, b) { return a.family.localeCompare(b.family); });
  return out;
}

module.exports = { listFonts: listFonts };
