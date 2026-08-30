// 曲库「一键清洗」：把标题里管理员自定义的"忽略词"(常见于画质/平台版本
// 标记，如 [1080p]、（抖音版）、（live）等)整体去掉，只留下干净的歌曲名；
// 同时如果标题里任意位置命中当前语种/风格预设列表里的取值（如"国语"
// "流行"，不要求出现在开头、结尾或某个固定分隔位置），顺带把这部分也从
// 标题里摘出来识别成语种/风格字段。
//
// 本模块只负责"从一段文本里识别、摘除这些片段"，是纯函数、不碰数据库；
// 具体识别到什么、摘除后剩下什么，交给调用方（server/index.js 的
// /api/admin/clean/preview）拼成预览结果，管理员对照确认后再批量写回。
//
// 兜底(误清洗保护)：中文没有天然的分词边界，"伤感的恋人"这种歌名，"伤感"
// 恰好也是常见风格预设取值，裸词(没有括号包裹)匹配没法用语法规则区分
// "这是贴在歌名外面的风格标签"还是"这就是歌名本身的一部分"——只能靠一个
// 启发式信号：如果裸词紧贴着的前/后一个字符也是汉字(说明它两边都没有
// 空格/分隔符/括号这类"标签边界"，很可能只是一段连续中文短语里凑巧出现
// 的子串，而不是被特意加在歌名外面的标签)，就把这次摘除标记成"低置信度"，
// 预览时不放进默认勾选(跟"清洗后歌名为空"一样需要管理员自己看一眼再决定
// 要不要应用)，避免类似"伤感的恋人"→"的恋人"这种把歌名"腰斩"的情况被
// 静默批量写回数据库。加了括号包裹的匹配(如"（伤感）")本身就是明确的标签
// 边界信号，不受这条限制，仍然按原来的逻辑默认勾选。
const path = require('path');

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// 常见成对括号：候选词左右如果恰好各自紧贴着同一种括号，就连括号一起摘
// 掉；只有单边括号、或者压根没有括号包裹，都只摘除词本身，不强行处理不
// 成对的括号，避免误伤词本身之外的内容。
const BRACKET_PAIRS = [['(', ')'], ['（', '）'], ['[', ']'], ['【', '】'], ['{', '}'], ['｛', '｝']];

// 为一个候选词（忽略词，或语种/风格预设取值）构建一条"可选带括号"的正
// 则：优先匹配"左括号+词+同一种右括号"整体，其次退回匹配裸词本身（大小
// 写不敏感，兼容"Live"/"live"/"LIVE"这类同一个词不同大小写的写法）。
function buildTokenRegex(word) {
  const esc = escapeRegex(word);
  const bracketAlts = BRACKET_PAIRS.map(([l, r]) => `\\${l}\\s*${esc}\\s*\\${r}`).join('|');
  return new RegExp(`(?:${bracketAlts})|(?:${esc})`, 'i');
}

// 判断一次匹配是不是"带括号"的——直接看匹配到的原文开头是不是某种左括号
// 字符即可，不需要另外记录是正则的哪个分支命中的。
function isBracketedMatch(matchText) {
  return BRACKET_PAIRS.some(([l]) => matchText.startsWith(l));
}

// 常见 CJK 表意文字范围：基本区 + 扩展A + 兼容表意文字，覆盖绝大多数简繁
// 中文歌名会用到的字，足够用来做"两边是不是紧贴着汉字"这个粗粒度判断，
// 不需要严谨到覆盖所有 Unicode CJK 区块。
const CJK_RE = /[\u4e00-\u9fa5\u3400-\u4dbf\uf900-\ufaff]/;

// 在候选词列表里找出"在文本中最早出现"的那一个匹配，而不是按列表顺序
// 找到第一个就用——这样结果只取决于文本本身长什么样，不会因为管理员把
// 忽略词/预设的先后顺序调整一下就跟着变化。
function findFirstMatch(text, words) {
  let best = null;
  for (const w of words) {
    const word = String(w == null ? '' : w).trim();
    if (!word) continue;
    const re = buildTokenRegex(word);
    const m = re.exec(text);
    if (m && (!best || m.index < best.index)) {
      best = { index: m.index, matchText: m[0], value: word };
    }
  }
  return best;
}

// 给一次命中打置信度标记：括号包裹的一律高置信度；裸词命中时，检查紧贴
// 着匹配片段的前一个/后一个字符——只要有一边是汉字（没有被空格/标点/
// 括号这类边界字符隔开），就判定成低置信度，交给管理员自己确认。
function markConfidence(text, hit) {
  const bracketed = isBracketedMatch(hit.matchText);
  let lowConfidence = false;
  if (!bracketed) {
    const before = hit.index > 0 ? text[hit.index - 1] : '';
    const afterIdx = hit.index + hit.matchText.length;
    const after = afterIdx < text.length ? text[afterIdx] : '';
    lowConfidence = CJK_RE.test(before) || CJK_RE.test(after);
  }
  return { text: hit.matchText, value: hit.value, bracketed, lowConfidence };
}

// 清理摘除片段后残留的多余分隔符/空括号/首尾空白，让结果是一个干净的歌
// 曲名，而不是留下"晴天--""晴天()"这类尾巴。
function tidySeparators(text) {
  let out = text;
  out = out.replace(/[\(（\[【\{｛]\s*[\)）\]】\}｝]/g, ''); // 摘除内容后留下的空括号
  out = out.replace(/[\s\-_·・.]{2,}/g, ' ');              // 连续分隔符合并成一个空格
  out = out.replace(/^[\s\-_·・.]+|[\s\-_·・.]+$/g, '');    // 首尾残留分隔符/空白
  return out.trim();
}

// 对一个标题做一次清洗。
//   rawTitle:   当前标题原文
//   noiseWords: 管理员自定义的忽略词列表，如 ["1080p", "抖音版", "live"]
//   presets:    { languages: [...], genres: [...] } 当前语种/风格预设列表
// 返回 { title, language, genre, removed, lowConfidence }：
//   - title    摘除忽略词、以及命中的语种/风格片段后剩下的纯净歌曲名
//   - language/genre 命中预设取值才有值（没命中是空字符串），调用方据此
//     判断"要不要覆盖数据库里原有的取值"，本函数本身不做这个决定
//   - removed  本次摘除掉的原文片段列表，每项 { text, value, bracketed,
//     lowConfidence }，供预览时展示"清洗掉了什么"以及是否需要格外留意
//   - lowConfidence 只要 removed 里有任意一项是低置信度，整条结果就标记
//     为低置信度，调用方据此决定预览时要不要默认勾选
function cleanTitle(rawTitle, noiseWords, presets) {
  let text = String(rawTitle == null ? '' : rawTitle);
  const removed = [];

  // 反复摘除忽略词，直到文本里再也找不到任何一个配置的忽略词为止——同一
  // 个词可能在标题里出现不止一次（比如"晴天[1080p][1080p]"这类重复标记
  // 的脏数据），不能只摘一次就停。guard 只是防止异常输入导致死循环。
  const noise = (noiseWords || []).map(w => String(w == null ? '' : w).trim()).filter(Boolean);
  let guard = 0;
  while (guard++ < 50) {
    const hit = findFirstMatch(text, noise);
    if (!hit) break;
    removed.push(markConfidence(text, hit));
    text = text.slice(0, hit.index) + text.slice(hit.index + hit.matchText.length);
  }

  // 语种：只认文本里最先出现的那一个预设取值，摘除对应片段。
  let language = '';
  const langHit = findFirstMatch(text, presets && presets.languages);
  if (langHit) {
    language = langHit.value;
    removed.push(markConfidence(text, langHit));
    text = text.slice(0, langHit.index) + text.slice(langHit.index + langHit.matchText.length);
  }

  // 风格：同语种，在摘除语种片段之后的文本里再找。
  let genre = '';
  const genreHit = findFirstMatch(text, presets && presets.genres);
  if (genreHit) {
    genre = genreHit.value;
    removed.push(markConfidence(text, genreHit));
    text = text.slice(0, genreHit.index) + text.slice(genreHit.index + genreHit.matchText.length);
  }

  text = tidySeparators(text);
  const lowConfidence = removed.some(r => r.lowConfidence);
  return { title: text, language, genre, removed, lowConfidence };
}

function baseNameOf(filename) {
  return path.basename(filename, path.extname(filename));
}

module.exports = { cleanTitle, baseNameOf };
