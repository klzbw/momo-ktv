// 文件名解析模板：让管理员按自己曲库文件真实的命名习惯，自定义一套解析
// 规则，而不是被绑死在 scanner.js 里默认的"歌手-歌曲名-语种-风格"这一种
// 顺序/分隔符组合上。
//
// 使用方式：管理员在「曲库管理」的"文件名解析"面板里，照着自己真实文件名
// 的样子填一份模板，把其中代表"歌手""歌名"的部分换成这两个词本身（或
// "歌曲名"），模板里其余的文字、标点（包括括号）原样保留，用来标记这些
// 字段在文件名里的真实位置和分隔方式。例如某批文件实际命名是
//   "周杰伦-晴天(国语-流行).mp4"
// 对应的模板就填"歌手-歌名(国语-流行)"——这里"国语""流行"不要求文件名里
// 必须一字不差地出现这两个词本身，而是因为它们本来就在系统的语种/风格
// 预设列表里，被系统识别成"这个位置是语种/风格字段"的占位标记（预设列表
// 增删后，可以当占位词用的词也会跟着变化），这样管理员不用背"语种""风格"
// 这两个抽象字段名，直接照着自己常用的取值填模板即可。
//
// 解析时，模板里除了字段占位词以外的所有文字（含括号）都当作必须原样匹配
// 的分隔符去定位字段边界；这些边界文字本身就不会进入任何字段的捕获结果
// （正则匹配时被当边界消耗掉），所以不需要、也不应该再对捕获到的字段值
// 做括号剥离——文件名里字段内容本身带的括号（比如"花儿为什么这样红(演)"
// 这类用括号标注演唱会/现场版的写法）要原样保留，否则会把"(演)"这种有
// 实际含义的版本标记跟正式曲名粘在一起，反而丢了信息、更难辨认。
const path = require('path');

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// 清理字段捕获结果首尾的空白。不再剥离括号——括号属于文件名字段内容本身
// 的一部分（如版本/现场标注），应该原样保留在结果里，只有模板本身用来
// 定位字段边界的字面文字才会被排除在捕获结果之外（这一步在正则匹配阶段
// 就已经完成，不需要这里再处理）。
function stripUseless(value) {
  return String(value == null ? '' : value).trim();
}

// 字段关键字本身（歌手/歌名等抽象字段名），固定可用，不依赖预设列表。
const EXPLICIT_KEYWORDS = [
  { text: '歌曲名', field: 'title' },
  { text: '歌名', field: 'title' },
  { text: '歌手', field: 'artist' },
  { text: '语种', field: 'language' },
  { text: '风格', field: 'genre' },
];

// 关键字之外，语种/风格预设里的具体取值（如"国语""流行"）本身也能在模板
// 里代表对应字段所在的位置，这样填模板时可以直接照抄自己惯用的语种/风格
// 取值，不用记抽象字段名。
function buildTokenList(presets) {
  const tokens = EXPLICIT_KEYWORDS.slice();
  (presets.languages || []).forEach(w => {
    if (w && String(w).trim()) tokens.push({ text: String(w).trim(), field: 'language' });
  });
  (presets.genres || []).forEach(w => {
    if (w && String(w).trim()) tokens.push({ text: String(w).trim(), field: 'genre' });
  });
  // 长词优先匹配（按文本长度降序），避免"歌名"抢先截断"歌曲名"这类互相
  // 包含的词；预设取值长度也各不相同，同样排序保证匹配到最贴切的那一个。
  tokens.sort((a, b) => b.text.length - a.text.length);
  // 同一段文本只保留第一次出现时的字段归属，避免因为预设、关键字重名导致
  // 同一个词被解释成两个不同字段。
  const seen = new Set();
  return tokens.filter(t => {
    if (seen.has(t.text)) return false;
    seen.add(t.text);
    return true;
  });
}

// 从左到右扫描模板文本，把它切成"字段占位"和"字面文字"两类片段。每个
// 位置优先尝试最长的候选词，匹配上就整体当作一个字段占位，否则这个字符
// 归入字面文字，继续往后扫描。
function tokenizePattern(pattern, tokens) {
  const segments = [];
  let i = 0;
  while (i < pattern.length) {
    let matched = null;
    for (const t of tokens) {
      if (pattern.startsWith(t.text, i)) { matched = t; break; }
    }
    if (matched) {
      segments.push({ type: 'field', field: matched.field });
      i += matched.text.length;
    } else {
      const last = segments[segments.length - 1];
      if (last && last.type === 'literal') last.text += pattern[i];
      else segments.push({ type: 'literal', text: pattern[i] });
      i++;
    }
  }
  return segments;
}

// 把"同一字段 + 相同分隔符"连续重复出现的片段（如"歌手&歌手"里的
// 字段-字面-字段）合并成一个整体：这类重复本身就是管理员在告诉系统"这个
// 位置上的值是用这个分隔符隔开的一串，不止一个"，所以不该按模板里写了
// 几次占位词，生成固定数量的捕获组——文件名里实际有 3 个、4 个甚至更多
// 用同一分隔符连起来的值时，多出来的都会挤进最后一个捕获组里，分隔符也
// 原样留在结果里拆不开（"歌手&歌手"配两位歌手没问题，配三位以上就会把
// 第三位开始的名字连着"&"一起粘进第二个歌手字段）。
// 合并后只生成一个捕获组，交由 parseWithTemplate 按记录下来的分隔符在
// 匹配到具体文件名之后再拆分——拆出几份完全取决于这个文件名本身用了几次
// 分隔符，与模板里占位词写了几次无关，从根上解决"最多只能识别模板里
// 写的那几个"的问题。
function collapseRepeatedFields(segments) {
  const out = [];
  let i = 0;
  while (i < segments.length) {
    const seg = segments[i];
    if (seg.type === 'field') {
      let j = i;
      let sep = null;
      while (true) {
        const litSeg = segments[j + 1];
        const nextField = segments[j + 2];
        if (litSeg && litSeg.type === 'literal' && nextField && nextField.type === 'field' && nextField.field === seg.field) {
          if (sep === null) sep = litSeg.text;
          if (litSeg.text !== sep) break; // 分隔符前后不一致，不当作同一组重复
          j += 2;
        } else {
          break;
        }
      }
      if (j > i) {
        out.push({ type: 'field', field: seg.field, listSep: sep });
        i = j + 1;
        continue;
      }
    }
    out.push(seg);
    i++;
  }
  return out;
}

// 编译用户填写的解析模板：presets 传入当前的语种/风格预设列表（见
// server/index.js 的 PRESET_LANGUAGE_KEY / PRESET_GENRE_KEY），这样模板里
// 能识别的占位词会随预设内容同步更新。返回 { ok:true, regex, fields } 或
// { ok:false, error }。
function compilePattern(patternStr, presets) {
  const pattern = String(patternStr || '').trim();
  if (!pattern) return { ok: false, error: '解析格式不能为空' };

  const tokens = buildTokenList(presets || {});
  const segments = collapseRepeatedFields(tokenizePattern(pattern, tokens));
  const fieldSegs = segments.filter(s => s.type === 'field');
  if (!fieldSegs.length) {
    return { ok: false, error: '未识别到任何字段占位词，请在格式里包含"歌手""歌名"等关键字，或当前预设里的语种/风格取值' };
  }
  if (!fieldSegs.some(s => s.field === 'title')) {
    return { ok: false, error: '解析格式必须包含"歌名"（或"歌曲名"）字段，歌名不能为空' };
  }

  let regexStr = '^';
  const fields = [];
  segments.forEach((seg, idx) => {
    if (seg.type === 'literal') {
      regexStr += escapeRegex(seg.text);
    } else {
      // 最后一个字段占位放开吃到结尾（再被后面的字面文字约束回退），
      // 中间的字段占位用非贪婪匹配，避免把后面属于其它字段/分隔符的内容
      // 也吞进当前字段里。
      const isLastField = !segments.slice(idx + 1).some(s => s.type === 'field');
      regexStr += isLastField ? '(.+)' : '(.+?)';
      fields.push({ field: seg.field, listSep: seg.listSep || null });
    }
  });
  regexStr += '$';

  let regex;
  try {
    regex = new RegExp(regexStr);
  } catch (e) {
    return { ok: false, error: '解析格式无法编译为有效规则: ' + e.message };
  }
  return { ok: true, regex, fields };
}

// 用编译好的模板匹配单个文件名（不含扩展名），返回
// { artist, title, language, genre }；文件名结构跟模板对不上（比如这首歌
// 根本不是这个命名格式）时返回 null，调用方据此判断"解析失败"，保留原有
// 信息不动，不会误写坏数据。
function parseWithTemplate(baseName, compiled) {
  if (!compiled || !compiled.ok) return null;
  const m = compiled.regex.exec(baseName);
  if (!m) return null;
  const collected = { artist: [], title: [], language: [], genre: [] };
  compiled.fields.forEach((fieldInfo, i) => {
    const raw = m[i + 1] == null ? '' : m[i + 1];
    if (fieldInfo.listSep) {
      // 该字段对应模板里"同字段+相同分隔符"的重复占位（如"歌手&歌手"），
      // 捕获到的是整段未拆分的原文，按这个分隔符切开——文件名里实际写了
      // 几个就拆出几个，不受模板占位词次数限制，也顺带处理了只有一个值、
      // 压根没出现分隔符的情况（split 结果就是它自己一份）。
      raw.split(fieldInfo.listSep).forEach(piece => {
        const val = stripUseless(piece);
        if (val) collected[fieldInfo.field].push(val);
      });
    } else {
      const val = stripUseless(raw);
      // 只收集非空的捕获结果：模板里同一字段占位重复出现时，可能只是极少见
      // 的关键字冲突导致某一次捕获为空，这种空值不应该混进最终结果。
      if (val) collected[fieldInfo.field].push(val);
    }
  });
  const out = {};
  Object.keys(collected).forEach(f => {
    // 同一字段在模板里重复出现，更常见的情况其实是管理员刻意这么写——比如
    // "歌手&歌手"表示这个位置有两位歌手、中间用"&"分隔。这些捕获到的值要
    // 按系统里"多歌手用空格分隔"的统一约定（见 scanner.js 的 splitArtists /
    // syncSongArtists）全部拼接保留，而不是只留第一次匹配到的值、把后面的
    // 歌手/取值丢掉——后者会导致"歌手&歌手"这类多歌手模板只解析出第一位。
    out[f] = collected[f].join(' ');
  });
  return out;
}

function baseNameOf(filename) {
  return path.basename(filename, path.extname(filename));
}

module.exports = { compilePattern, parseWithTemplate, baseNameOf, stripUseless };
