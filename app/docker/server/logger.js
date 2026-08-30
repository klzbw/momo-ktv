// 统一日志格式：[时间] [标签] 内容
// 所有日志都走 console.log/warn/error，会原样进 stdout/stderr，
// 因此 `docker logs -f momo-ktv` 就能看到，不需要额外配置。
//
// 标签约定（方便 grep 排查问题）：
//   [VAAPI]     核显(VAAPI)硬件加速探测/初始化相关
//   [TRANSCODE] 单首歌/单条轨道的转码生命周期(开始/结束/耗时/失败)
//   [VOICE]     原唱/伴唱切换事件
//   [HLS]       播放请求/分片等待相关
//   [HLS_CLEAN] HLS 缓存每日清理任务相关
//   [STREAM]    /stream/:id 原始文件直连播放相关(硬解/客户端解码路径)
//   [DECODE]    客户端(Android/TV等)上报的解码模式(硬解/软解)切换事件
//   [PROCESS]   进程级兜底(unhandledRejection/uncaughtException)捕获到的意外错误

function ts() {
  const d = new Date();
  const pad = (n, l = 2) => String(n).padStart(l, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
         `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

function fmt(tag, msg) {
  return `[${ts()}] [${tag}] ${msg}`;
}

module.exports = {
  info(tag, msg) { console.log(fmt(tag, msg)); },
  warn(tag, msg) { console.warn(fmt(tag, msg)); },
  error(tag, msg) { console.error(fmt(tag, msg)); },
};
