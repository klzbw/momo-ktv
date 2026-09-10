/**
 * mkv-player.js — MSE MKV 直连播放器（纯 JS，无构建依赖）
 *
 * 工作原理：
 *   浏览器直接 fetch 115 CDN 的 MKV 字节流（经 /api/direct-stream/ 302 跳转），
 *   JS 端用轻量 EBML 解析器解封装出 H.264 视频帧 + AAC 音频帧，
 *   再用手写的 fMP4 muxer 封装成 fMP4（ftyp+moov+moof+mdat）喂给 MediaSource，
 *   完全不经过 NAS 转码/代理媒体数据。
 *
 * 仅针对 KTV MKV 固定格式：H.264(V_MPEG4/ISO/AVC) + 2 条 AAC(A_AAC)，无字幕无附件。
 *
 * 暴露：window.MkvMsePlayer
 *
 * 用法：
 *   const p = new MkvMsePlayer();
 *   await p.load(url, { audioTrackIndex: 0 });  // 解析头+探测CORS
 *   p.attachMedia(videoEl);                       // 挂到 <video>，起播
 *   p.setAudioTrack(1);                           // 切到伴唱
 *   p.destroy();                                  // 清理
 */
(function (global) {
  'use strict';

  // ═══════════════════════════════════════════════════════════════════
  // EBML / Matroska 元素 ID 常量（仅列出本播放器需要的）
  // ═══════════════════════════════════════════════════════════════════
  const ID = {
    EBML:        0x1A45DFA3,
    SEGMENT:     0x18538067,
    SEEK_HEAD:   0x114D9B74,
    INFO:        0x1549A966,
    TRACKS:      0x1654AE6B,
    CLUSTER:     0x1F43B675,
    // Info
    TIMECODE_SCALE: 0x2AD7B1,
    DURATION:       0x4489,
    // Tracks
    TRACK_ENTRY:    0xAE,
    TRACK_NUMBER:   0xD7,
    TRACK_TYPE:     0x83,
    CODEC_ID:       0x86,
    CODEC_PRIVATE:  0x63A2,
    VIDEO:          0xE0,
    PIXEL_WIDTH:   0xB0,
    PIXEL_HEIGHT:   0xBA,
    AUDIO:          0xE1,
    SAMPLING_FREQ:  0xB5,
    CHANNELS:       0x9F,
    // Cluster
    TIMESTAMP:     0xE7,
    SIMPLE_BLOCK:   0xA3,
    BLOCK_GROUP:    0xA0,
    BLOCK:          0xA1,
  };
  const TRACK_TYPE_VIDEO = 1;
  const TRACK_TYPE_AUDIO = 2;

  // ═══════════════════════════════════════════════════════════════════
  // 工具：字节拼接 / 写二进制
  // ═══════════════════════════════════════════════════════════════════
  function concat() {
    const parts = [];
    let total = 0;
    for (let i = 0; i < arguments.length; i++) {
      const p = arguments[i];
      if (!p) continue;
      parts.push(p);
      total += p.length;
    }
    const out = new Uint8Array(total);
    let o = 0;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
  }
  function u8(v)  { const a = new Uint8Array(1); a[0] = v & 0xFF; return a; }
  function u16(v) { const a = new Uint8Array(2); new DataView(a.buffer).setUint16(0, v); return a; }
  function u24(v) { const a = new Uint8Array(3); const d = new DataView(a.buffer); d.setUint8(0, (v >> 16) & 0xFF); d.setUint8(1, (v >> 8) & 0xFF); d.setUint8(2, v & 0xFF); return a; }
  function u32(v) { const a = new Uint8Array(4); new DataView(a.buffer).setUint32(0, v); return a; }
  function u64(v) { const a = new Uint8Array(8); const d = new DataView(a.buffer); d.setUint32(0, Math.floor(v / 0x100000000)); d.setUint32(4, v >>> 0); return a; }
  function s16(v) { const a = new Uint8Array(2); new DataView(a.buffer).setInt16(0, v); return a; }
  function beFloat(v) { const a = new Uint8Array(4); new DataView(a.buffer).setFloat32(0, v); return a; }
  function str(s) { const a = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) a[i] = s.charCodeAt(i); return a; }
  function zeros(n) { return new Uint8Array(n); }
  function identityMatrix() {
    // 标准 MP4 恒等矩阵（36 字节）
    return new Uint8Array([
      0,0x01,0,0, 0,0,0,0, 0,0,0,0,
      0,0,0,0, 0,0x01,0,0, 0,0,0,0,
      0,0,0,0, 0,0,0,0, 0x40,0,0,0
    ]);
  }

  // ═══════════════════════════════════════════════════════════════════
  // MP4 Box 构造
  // ═══════════════════════════════════════════════════════════════════
  function box(type, body) {
    const size = 8 + body.length;
    const out = new Uint8Array(size);
    const dv = new DataView(out.buffer);
    dv.setUint32(0, size);
    dv.setUint32(4, (type.charCodeAt(0) << 24) | (type.charCodeAt(1) << 16) | (type.charCodeAt(2) << 8) | type.charCodeAt(3));
    out.set(body, 8);
    return out;
  }
  function fullBox(type, version, flags, body) {
    return box(type, concat(u8(version), u8((flags >> 16) & 0xFF), u8((flags >> 8) & 0xFF), u8(flags & 0xFF), body));
  }

  // ftyp
  function ftypBox() {
    return box('ftyp', concat(str('iso5'), u32(0x200), str('iso5'), str('iso2'), str('avc1'), str('mp41')));
  }

  // mvhd（timescale 单位：秒的分母）
  function mvhdBox(timescale, duration, nextTrackId) {
    const body = concat(
      u32(0), u32(0),
      u32(timescale), u32(duration),
      u32(0x00010000), u16(0x0100),
      zeros(10),
      identityMatrix(),
      zeros(24),
      u32(nextTrackId)
    );
    return fullBox('mvhd', 0, 0, body);
  }

  // tkhd
  function tkhdBox(trackId, width, height, volume, duration) {
    const body = concat(
      u32(0), u32(0),
      u32(trackId),
      u32(0),
      u32(duration),
      zeros(8),
      u16(0), u16(0),          // layer, alt group
      u16(volume), u16(0),     // volume
      identityMatrix(),
      u32(Math.round(width * 65536)),
      u32(Math.round(height * 65536))
    );
    return fullBox('tkhd', 0, 0x7 /*enabled|inMovie|inPreview*/, body);
  }

  // mdhd
  function mdhdBox(timescale, duration) {
    const body = concat(
      u32(0), u32(0),
      u32(timescale), u32(duration),
      u16(0x55C0), u16(0)  // language 'und', pre-defined
    );
    return fullBox('mdhd', 0, 0, body);
  }

  // hdlr
  function hdlrBox(handlerType) {
    const body = concat(
      u32(0),
      str(handlerType),
      zeros(12),
      str('momo-mkv'), u8(0)
    );
    return fullBox('hdlr', 0, 0, body);
  }

  // dinf/dref
  function dinfBox() {
    const urlEntry = fullBox('url ', 0, 0x01 /*self-contained*/, zeros(0));
    const dref = fullBox('dref', 0, 0, concat(u32(1), urlEntry));
    return box('dinf', dref);
  }

  // vmhd（视频 media header）
  function vmhdBox() { return fullBox('vmhd', 0, 1 /*presentation*/, u16(0)); }
  // smhd（音频 media header）
  function smhdBox() { return fullBox('smhd', 0, 0, concat(u16(0), u16(0))); }

  // stsd：视频 avc1（内嵌 avcC）
  function stsdVideoBox(codecPrivate, width, height) {
    // avcC 直接就是 MKV CodecPrivate（AVCDecoderConfigurationRecord）
    const avcC = box('avcC', codecPrivate);
    // avc1 visual sample entry
    const entry = concat(
      zeros(6),            // reserved
      u16(1),              // data_reference_index
      zeros(16),           // pre-defined + reserved
      u16(width), u16(height),
      u32(0x00480000),     // horizres 72dpi
      u32(0x00480000),     // vertres
      u32(0),              // reserved
      u16(1),              // frame_count
      zeros(32),           // compressorname
      u16(0x0018),         // depth
      u16(0xFFFF),         // pre-defined (-1)
      avcC
    );
    const body = concat(u32(0) /*version+flags*/, u32(1) /*entry_count*/, box('avc1', entry));
    return fullBox('stsd', 0, 0, body);
  }

  // stsd：音频 mp4a（内嵌 esds，esds 里包 AudioSpecificConfig）
  function stsdAudioBox(codecPrivate, channels, sampleRate) {
    // 构造 esds（MPEG-4 DSM descriptor）
    const asc = codecPrivate; // MKV A_AAC CodecPrivate 即 AudioSpecificConfig
    const decSpecificInfo = concat(u8(0x05), u8(asc.length), asc);
    const slConfig = concat(u8(0x06), u8(0x01), u8(0x02));
    const decoderConfig = concat(
      u8(0x04),
      u8(13 + asc.length), // length = 13 (固定字段) + asc.length
      u8(0x40),            // objectTypeIndication: Audio ISO/IEC 14496-3
      u8(0x15),            // streamType=5(audio) <<2 | upstream=1
      u24(0x000000),       // bufferSizeDB
      u32(0),              // maxBitrate
      u32(0),              // avgBitrate
      decSpecificInfo,
      slConfig
    );
    const esDescriptor = concat(
      u8(0x03),
      u8(3 + decoderConfig.length),
      u16(0x01),           // ES_ID
      u8(0x00),            // flags
      decoderConfig
    );
    const esds = fullBox('esds', 0, 0, esDescriptor);

    const entry = concat(
      zeros(6),            // reserved
      u16(1),              // data_reference_index
      zeros(8),            // reserved
      u16(channels),       // channels
      u16(16),             // samplesize
      u16(0), u16(0),      // pre-defined, reserved
      u32(sampleRate << 16), // samplerate (16.16 fixed)
      esds
    );
    const body = concat(u32(0), u32(1), box('mp4a', entry));
    return fullBox('stsd', 0, 0, body);
  }

  // 空 stbl 子表（init segment 里不填样本级信息，由 moof/trun 提供）
  function sttsEmpty() { return fullBox('stts', 0, 0, u32(0)); }
  function stscEmpty() { return fullBox('stsc', 0, 0, u32(0)); }
  function stszEmpty() { return fullBox('stsz', 0, 0, concat(u32(0), u32(0))); }

  // stbl 组装
  function stblBox(video, stsd) {
    const children = video
      ? concat(stsd, sttsEmpty(), stscEmpty(), stszEmpty())
      : concat(stsd, sttsEmpty(), stscEmpty(), stszEmpty());
    return box('stbl', children);
  }

  // minf
  function minfBox(video, stsd) {
    const header = video ? vmhdBox() : smhdBox();
    return box('minf', concat(header, dinfBox(), stblBox(video, stsd)));
  }

  // mdia
  function mdiaBox(video, handlerType, timescale, duration, stsd) {
    return box('mdia', concat(mdhdBox(timescale, duration), hdlrBox(handlerType), minfBox(video, stsd)));
  }

  // trak
  function trakBox(video, trackId, width, height, volume, timescale, duration, stsd) {
    return box('trak', concat(tkhdBox(trackId, width, height, volume, duration), mdiaBox(video, video ? 'vide' : 'soun', timescale, duration, stsd)));
  }

  // moov（init segment 用）
  function moovBox(tracks, duration) {
    // tracks: [{video:bool, trackId, width, height, volume, timescale, stsd}]
    let trackBoxes = zeros(0);
    for (const t of tracks) {
      trackBoxes = concat(trackBoxes, trakBox(t.video, t.trackId, t.width, t.height, t.volume, t.timescale, duration, t.stsd));
    }
    return box('moov', concat(mvhdBox(1000000, duration, tracks.length + 1), trackBoxes));
  }

  // ── fragment boxes（moof + mdat）─────────────────────────────────────
  function mfhdBox(seq) { return fullBox('mfhd', 0, 0, u32(seq)); }

  function tfhdBox(trackId, flags) {
    // flags: default-base-is-moof (0x02000000) 等
    const body = concat(u32(trackId));
    return fullBox('tfhd', 0, flags, body);
  }

  function tfdtBox(baseMediaDecodeTime) {
    // version 1 用 64bit，避免 long video 溢出
    return fullBox('tfdt', 1, 0, u64(baseMediaDecodeTime));
  }

  // trun：samples 为 [{size, duration, flags?}]
  function trunBox(flags, dataOffset, firstSampleFlags, samples) {
    const parts = [u32(samples.length)];
    if (flags & 0x100) parts.push(u32(dataOffset));           // data-offset-present
    if (flags & 0x200) parts.push(u32(firstSampleFlags));    // first-sample-flags-present
    for (const s of samples) {
      if (flags & 0x400) parts.push(u32(s.duration));        // sample-duration
      if (flags & 0x800) parts.push(u32(s.size));            // sample-size
      if (flags & 0x1000) parts.push(u32(s.flags));          // sample-flags
    }
    return fullBox('trun', 0, flags, concat.apply(null, parts));
  }

  // ═══════════════════════════════════════════════════════════════════
  // 流式字节读取器：按 HTTP Range 分段拉取，维护一个滑动窗口
  // ═══════════════════════════════════════════════════════════════════
  class RangeReader {
    constructor(url, abortSignal) {
      this._url = url;
      this._signal = abortSignal;
      this._buf = new Uint8Array(0); // 当前窗口
      this._winStart = 0;            // 窗口首字节在文件中的偏移
      this._pos = 0;                 // 窗口内当前读位置
      this._eof = false;
      this._fetched = 0;             // 已拉取的总字节（日志用）
    }

    // 当前绝对文件偏移
    tell() { return this._winStart + this._pos; }

    // 跳到绝对文件偏移
    seek(absOff) {
      this._winStart = absOff;
      this._buf = new Uint8Array(0);
      this._pos = 0;
      this._eof = false;
    }

    // 确保窗口内至少有 n 字节可用（不足则继续拉）
    async ensure(n) {
      while (this._buf.length - this._pos < n) {
        if (this._eof) throw new Error('EBML 读取越界 EOF');
        const need = Math.max(n - (this._buf.length - this._pos), 64 * 1024);
        const start = this._winStart + this._buf.length;
        const end = start + need - 1;
        const resp = await fetch(this._url, {
          headers: { Range: `bytes=${start}-${end}` },
          signal: this._signal,
        });
        if (resp.status !== 206 && resp.status !== 200) {
          throw new Error('Range 请求失败 HTTP ' + resp.status);
        }
        const data = new Uint8Array(await resp.arrayBuffer());
        if (data.length === 0) { this._eof = true; break; }
        // 服务端可能忽略 Range 返回 200 全量：此时按起始偏移对齐
        let fileStart = start;
        if (resp.status === 200) {
          // 全量响应：把窗口对齐到文件 0
          this._buf = data;
          this._winStart = 0;
          this._pos = 0;
          this._eof = true;
          this._fetched += data.length;
          continue;
        }
        this._buf = concat(this._buf, data);
        this._fetched += data.length;
      }
      // 释放已读部分，控制内存
      if (this._pos > 256 * 1024) {
        const keep = this._buf.length - this._pos;
        this._winStart += this._pos;
        this._buf = this._buf.slice(this._pos);
        this._pos = 0;
      }
    }

    // 读一个 VINT（EBML 变长整数），返回 {value, length, unknown}
    async readVint() {
      await this.ensure(1);
      const first = this._buf[this._pos];
      let len = 0;
      for (let i = 0; i < 8; i++) {
        if (first & (0x80 >> i)) { len = i + 1; break; }
      }
      if (len === 0) throw new Error('非法 VINT');
      await this.ensure(len);
      let val = this._buf[this._pos] & (0xFF >> len);
      for (let i = 1; i < len; i++) {
        val = (val << 8) | this._buf[this._pos + i];
      }
      this._pos += len;
      // 全 1 = unknown size
      const allOne = (() => {
        const mask = (0x80 >> (len - 1)) - 1;
        let v = first & mask;
        if (v !== mask) return false;
        for (let i = 1; i < len; i++) if (this._buf[this._pos - len + i] !== 0xFF) return false;
        return true;
      })();
      return { value: val, length: len, unknown: allOne };
    }

    // 读 N 字节（返回拷贝）
    async readBytes(n) {
      await this.ensure(n);
      const out = this._buf.slice(this._pos, this._pos + n);
      this._pos += n;
      return out;
    }

    // 读 uint（n=1..8 字节；>4 字节用乘积累加避免位运算截断）
    async readUint(n) {
      const b = await this.readBytes(n);
      let v = 0;
      for (let i = 0; i < n; i++) v = v * 256 + b[i];
      return v;
    }
    async readInt(n) {
      const b = await this.readBytes(n);
      let v = 0;
      for (let i = 0; i < n; i++) v = v * 256 + b[i];
      if (b[0] & 0x80) v -= Math.pow(2, 8 * n);
      return v;
    }
    async readFloat() {
      const b = await this.readBytes(4);
      return new DataView(b.buffer).getFloat32(0);
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // MkvMsePlayer 主类
  // ═══════════════════════════════════════════════════════════════════
  class MkvMsePlayer {
    constructor() {
      this._url = null;
      this._abort = null;          // AbortController
      this._reader = null;
      this._videoEl = null;
      this._ms = null;             // MediaSource
      this._videoSB = null;        // SourceBuffer (video)
      this._audioSB = null;       // SourceBuffer (audio)
      this._tracks = { video: null, audios: [] };
      this._timecodeScale = 1000000; // ns per timestamp tick
      this._duration = 0;            // 秒
      this._clusters = [];           // [{fileOffset, timecode(us)}]
      this._currentAudioIdx = 0;
      this._seq = 0;                 // moof sequence number
      this._destroyed = false;
      this._streaming = false;
      this._streamToken = 0;         // 每次重置递增，丢弃旧异步循环
      this._audioOnlyMode = false;   // 切音轨后只补音频
      this._mimeVideo = '';
      this._mimeAudio = 'audio/mp4; codecs="mp4a.40.2"';
      this._initVideoSeg = null;
      this._initAudioSeg = null;
      this._ended = false;
    }

    /** 探测 + 解析头部。失败 throw（上层回退）。 */
    async load(url, opts) {
      opts = opts || {};
      this._url = url;
      this._currentAudioIdx = opts.audioTrackIndex || 0;

      // 0) 能力检测
      if (typeof MediaSource === 'undefined' || !MediaSource.isTypeSupported) {
        throw new Error('MediaSource 不可用');
      }

      // 1) CORS / Range 探测：拉前 64KB
      this._abort = new AbortController();
      this._reader = new RangeReader(url, this._abort.signal);
      // 触发一次真实拉取（ensure 64KB）
      await this._reader.ensure(64 * 1024);

      // 2) 解析 EBML 头
      await this._parseHeader();

      if (!this._tracks.video) throw new Error('未找到视频轨');
      if (this._tracks.audios.length < 1) throw new Error('未找到音频轨');

      // 3) 构造 fMP4 init segment
      this._buildInitSegment();
    }

    /** 挂到 <video> 并起播 */
    attachMedia(videoEl) {
      if (!this._initVideoSeg) throw new Error('未 load 就 attach');
      this._videoEl = videoEl;
      const ms = new MediaSource();
      this._ms = ms;
      const self = this;
      ms.addEventListener('sourceopen', function onOpen() {
        ms.removeEventListener('sourceopen', onOpen);
        try {
          self._onSourceOpen();
        } catch (e) {
          console.error('[MSE-MKV] sourceopen 失败', e);
          // 触发 error 回退
          videoEl.dispatchEvent(new Event('error'));
        }
      });
      videoEl.src = URL.createObjectURL(ms);
    }

    _onSourceOpen() {
      const ms = this._ms;
      const videoSB = ms.addSourceBuffer(this._mimeVideo);
      const audioSB = ms.addSourceBuffer(this._mimeAudio);
      this._videoSB = videoSB;
      this._audioSB = audioSB;
      videoSB.mode = 'segments';
      audioSB.mode = 'segments';

      // 设置时长
      if (this._duration > 0) {
        try { ms.duration = Math.floor(this._duration * 1000) / 1000; } catch (e) {}
      }

      // 先 append init segment（ftyp+moov 同时包含视频/音频轨道；音频 init 已并入 moov）
      this._appendQueue(this._initVideoSeg, videoSB)
        .then(() => {
          if (this._initAudioSeg && this._initAudioSeg.length > 0) {
            return this._appendQueue(this._initAudioSeg, audioSB);
          }
        })
        .then(() => {
          if (this._destroyed) return;
          // 起播流式循环
          this._startStreaming(0);
        })
        .catch((e) => {
          console.warn('[MSE-MKV] init segment append 失败，触发回退', e);
          try { this._videoEl.dispatchEvent(new Event('error')); } catch (_) {}
        });
    }

    /** 切换音轨（index: 0=原唱, 1=伴唱） */
    async setAudioTrack(index) {
      if (index === this._currentAudioIdx) return;
      if (index >= this._tracks.audios.length) return;
      this._currentAudioIdx = index;
      const v = this._videoEl;
      if (!v) return;
      const t = isFinite(v.currentTime) ? v.currentTime : 0;
      console.log('[MSE-MKV] 切换音轨 ->', index, 'at', t.toFixed(2) + 's');

      // 暂停当前流式循环
      this._streamToken++;
      this._streaming = false;
      if (this._abort) { try { this._abort.abort(); } catch (e) {} }
      this._abort = new AbortController();
      this._reader = new RangeReader(this._url, this._abort.signal);

      // 清空音频 SourceBuffer（视频保留，不影响画面）
      try {
        const ab = this._audioSB;
        if (ab) {
          await this._whenDone(ab);
          // 移除所有已缓冲音频
          const buffered = ab.buffered;
          for (let i = buffered.length - 1; i >= 0; i--) {
            ab.remove(buffered.start(i), buffered.end(i));
          }
          await this._whenDone(ab);
        }
      } catch (e) { console.warn('[MSE-MKV] flush audio buffer', e); }

      // 找到 t 对应的 cluster
      const clusterOff = this._findClusterAt(t);
      this._reader.seek(clusterOff);
      this._audioOnlyMode = true; // 只补音频，视频缓冲仍在
      this._startStreaming(clusterOff, t);
    }

    /** 销毁，释放所有资源 */
    destroy() {
      this._destroyed = true;
      this._streamToken++;
      this._streaming = false;
      if (this._abort) { try { this._abort.abort(); } catch (e) {} }
      try {
        const ms = this._ms;
        if (ms && ms.readyState === 'open') {
          if (this._videoSB) { try { ms.removeSourceBuffer(this._videoSB); } catch (e) {} }
          if (this._audioSB) { try { ms.removeSourceBuffer(this._audioSB); } catch (e) {} }
          try { ms.endOfStream(); } catch (e) {}
        }
      } catch (e) {}
      this._videoSB = null;
      this._audioSB = null;
      this._ms = null;
      if (this._videoEl) {
        try { this._videoEl.removeAttribute('src'); this._videoEl.load(); } catch (e) {}
      }
    }

    // ────────────────────────────────────────────────────────────────
    // 头部解析
    // ────────────────────────────────────────────────────────────────
    async _parseHeader() {
      const r = this._reader;
      // EBML 头（校验）
      const ebmlId = await r.readVint();
      if (ebmlId.value !== ID.EBML) throw new Error('不是 EBML 文件');
      const ebmlSize = await r.readVint();
      await r.ensure(ebmlSize.value);
      // 跳过 EBML body（我们不需要 DocType 等）
      r._pos += ebmlSize.value;

      // Segment
      const segId = await r.readVint();
      if (segId.value !== ID.SEGMENT) throw new Error('缺少 Segment');
      const segSize = await r.readVint();
      const segStart = r.tell();
      const segEnd = segSize.unknown ? Infinity : segStart + segSize.value;

      // 遍历 Segment 子元素，找 Info / Tracks
      while (r.tell() < segEnd) {
        const elemElemStart = r.tell(); // 元素起始（ID 之前）
        const elemId = await r.readVint();
        const elemSize = await r.readVint();
        const elemStart = r.tell();
        const elemEnd = elemStart + (elemSize.unknown ? 0 : elemSize.value);
        if (elemId.value === ID.SEEK_HEAD) {
          // SeekHead：跳过（我们直接顺序扫，不必用它）
          r._pos += elemSize.value;
        } else if (elemId.value === ID.INFO) {
          await this._parseInfo(r, elemStart, elemEnd);
          r._pos += (elemEnd - r.tell());
        } else if (elemId.value === ID.TRACKS) {
          await this._parseTracks(r, elemStart, elemEnd);
          r._pos += (elemEnd - r.tell());
        } else if (elemId.value === ID.CLUSTER) {
          // 第一个 cluster 出现：记录文件偏移（ID 之前），头部解析完毕
          this._firstClusterOffset = elemElemStart;
          break;
        } else {
          // 其它未知元素，跳过
          r._pos += elemSize.value;
        }
      }
    }

    async _parseInfo(r, start, end) {
      while (r.tell() < end) {
        const id = await r.readVint();
        const size = await r.readVint();
        const s = r.tell();
        const e = s + size.value;
        if (id.value === ID.TIMECODE_SCALE) {
          this._timecodeScale = await r.readUint(4);
        } else if (id.value === ID.DURATION) {
          const f = await r.readFloat();
          // Duration 单位是 TimecodeScale ns，转秒
          this._duration = (f * this._timecodeScale) / 1e9;
        } else {
          r._pos += size.value;
        }
        r._pos = e;
      }
    }

    async _parseTracks(r, start, end) {
      while (r.tell() < end) {
        const id = await r.readVint();
        const size = await r.readVint();
        const s = r.tell();
        const e = s + size.value;
        if (id.value === ID.TRACK_ENTRY) {
          await this._parseTrackEntry(r, s, e);
          r._pos = e;
        } else {
          r._pos += size.value;
        }
      }
    }

    async _parseTrackEntry(r, start, end) {
      let trackNum = 0, trackType = 0, codecID = '';
      let codecPrivate = null;
      let width = 0, height = 0, channels = 2, sampleRate = 44100;
      while (r.tell() < end) {
        const id = await r.readVint();
        const size = await r.readVint();
        const s = r.tell();
        const e = s + size.value;
        switch (id.value) {
          case ID.TRACK_NUMBER: trackNum = await r.readUint(Math.min(8, size.value)); break;
          case ID.TRACK_TYPE: trackType = await r.readUint(size.value); break;
          case ID.CODEC_ID:
            codecID = '';
            {
              const b = await r.readBytes(size.value);
              for (const c of b) codecID += String.fromCharCode(c);
            }
            break;
          case ID.CODEC_PRIVATE: codecPrivate = await r.readBytes(size.value); break;
          case ID.VIDEO: {
            // Video 子元素
            let vs = s, ve = e;
            while (r.tell() < ve) {
              const vid = await r.readVint();
              const vsz = await r.readVint();
              const vd = r.tell();
              const vde = vd + vsz.value;
              if (vid.value === ID.PIXEL_WIDTH) width = await r.readUint(2);
              else if (vid.value === ID.PIXEL_HEIGHT) height = await r.readUint(2);
              else r._pos += vsz.value;
              r._pos = vde;
            }
            break;
          }
          case ID.AUDIO: {
            // Audio 子元素
            let ae = e;
            while (r.tell() < ae) {
              const aid = await r.readVint();
              const asz = await r.readVint();
              const ad = r.tell();
              const ade = ad + asz.value;
              if (aid.value === ID.SAMPLING_FREQ) sampleRate = await r.readFloat();
              else if (aid.value === ID.CHANNELS) channels = await r.readUint(asz.value);
              else r._pos += asz.value;
              r._pos = ade;
            }
            break;
          }
          default:
            r._pos += size.value;
        }
        r._pos = e;
      }
      const track = {
        trackNum, trackType, codecID, codecPrivate,
        width, height, channels, sampleRate,
      };
      if (trackType === TRACK_TYPE_VIDEO && /AVC/i.test(codecID)) {
        this._tracks.video = track;
      } else if (trackType === TRACK_TYPE_AUDIO && /AAC/i.test(codecID)) {
        this._tracks.audios.push(track);
      }
    }

    // ────────────────────────────────────────────────────────────────
    // fMP4 init segment
    // ────────────────────────────────────────────────────────────────
    _buildInitSegment() {
      const v = this._tracks.video;
      // 从 avcC 取 profile/compat/level 构造 codec string
      // avcC: [0]=ver [1]=profile [2]=compat [3]=level
      const cp = v.codecPrivate;
      const profile = cp[1], compat = cp[2], level = cp[3];
      const avcStr = 'avc1.' +
        profile.toString(16).padStart(2, '0') +
        compat.toString(16).padStart(2, '0') +
        level.toString(16).padStart(2, '0');
      this._mimeVideo = 'video/mp4; codecs="' + avcStr + '"';

      const timescale = 1000000; // 1us
      const duration = Math.ceil(this._duration * timescale);

      const stsdV = stsdVideoBox(cp, v.width, v.height);
      const stsdA = stsdAudioBox(
        this._tracks.audios[0].codecPrivate,
        this._tracks.audios[0].channels,
        this._tracks.audios[0].sampleRate
      );

      const tracks = [
        { video: true, trackId: 1, width: v.width, height: v.height, volume: 0, timescale, stsd: stsdV },
        { video: false, trackId: 2, width: 0, height: 0, volume: 256, timescale, stsd: stsdA },
      ];
      const moov = moovBox(tracks, duration);
      const ftyp = ftypBox();
      this._initVideoSeg = concat(ftyp, moov);
      this._initAudioSeg = new Uint8Array(0); // 音频 init 已并入 moov
    }

    // ────────────────────────────────────────────────────────────────
    // 流式读取 + mux + append
    // ────────────────────────────────────────────────────────────────
    async _startStreaming(fromOffset, resumeTimeSec) {
      const token = ++this._streamToken;
      this._streaming = true;
      const r = this._reader;
      if (fromOffset != null) r.seek(fromOffset);
      else if (this._firstClusterOffset != null) r.seek(this._firstClusterOffset);

      const timescale = 1000000; // us
      let clusterTimeUs = 0;
      let vSamples = []; // 当前 chunk 的视频样本
      let aSamples = []; // 当前 chunk 的音频样本
      let vSampleBytes = new Uint8Array(0);
      let aSampleBytes = new Uint8Array(0);
      let chunkStartUs = null;
      const CHUNK_VIDEO_BYTES = 512 * 1024; // 每个 fMP4 segment 最多攒 ~512KB 视频
      const self = this;

      // 把当前攒的样本 flush 成一个 moof+mdat 并 append
      async function flushChunk() {
        if (vSamples.length === 0 && aSamples.length === 0) return;
        if (chunkStartUs == null) return;
        self._seq++;
        const seq = self._seq;

        // 按需组装 traf：audio-only 模式下视频无样本，不写视频 traf
        const hasV = vSamples.length > 0;
        const hasA = aSamples.length > 0;

        // 预计算各 traf 大小（data_offset 占位 0）
        let vTraf0 = null, aTraf0 = null;
        if (hasV) {
          const vTfhd = tfhdBox(1, 0x02000000 /*default-base-is-moof*/);
          const vTfdt = tfdtBox(chunkStartUs);
          const vHasKeyFlags = vSamples.some(s => s.key);
          const vTrunFlags = 0x100 | 0x400 | 0x800 | (vHasKeyFlags ? 0x200 | 0x1000 : 0);
          const firstVFlags = vSamples[0].key ? 0 : 0x01000000;
          const vTrun = trunBox(vTrunFlags, 0, firstVFlags, vSamples.map(s => ({
            size: s.size, duration: s.duration, flags: s.key ? 0 : 0x01000000,
          })));
          vTraf0 = box('traf', concat(vTfhd, vTfdt, vTrun));
        }
        if (hasA) {
          const aTfhd = tfhdBox(2, 0x02000000);
          const aTfdt = tfdtBox(chunkStartUs);
          const aTrunFlags = 0x100 | 0x400 | 0x800;
          const aTrun = trunBox(aTrunFlags, 0, 0, aSamples.map(s => ({ size: s.size, duration: s.duration })));
          aTraf0 = box('traf', concat(aTfhd, aTfdt, aTrun));
        }

        const mfhd = mfhdBox(seq);
        let moofBody = concat(mfhd, vTraf0, aTraf0);
        const moofSize = 8 + moofBody.length;

        // 计算 data_offset（相对 moof 起始），mdat header 8 字节后是样本数据
        const vDataOff = moofSize + 8;
        const aDataOff = moofSize + 8 + (hasV ? vSampleBytes.length : 0);

        // 用正确 data_offset 重建 trun/traf
        let vTraf = null, aTraf = null;
        if (hasV) {
          const vTfhd = tfhdBox(1, 0x02000000);
          const vTfdt = tfdtBox(chunkStartUs);
          const vHasKeyFlags = vSamples.some(s => s.key);
          const vTrunFlags = 0x100 | 0x400 | 0x800 | (vHasKeyFlags ? 0x200 | 0x1000 : 0);
          const firstVFlags = vSamples[0].key ? 0 : 0x01000000;
          const vTrun = trunBox(vTrunFlags, vDataOff, firstVFlags, vSamples.map(s => ({
            size: s.size, duration: s.duration, flags: s.key ? 0 : 0x01000000,
          })));
          vTraf = box('traf', concat(vTfhd, vTfdt, vTrun));
        }
        if (hasA) {
          const aTfhd = tfhdBox(2, 0x02000000);
          const aTfdt = tfdtBox(chunkStartUs);
          const aTrunFlags = 0x100 | 0x400 | 0x800;
          const aTrun = trunBox(aTrunFlags, aDataOff, 0, aSamples.map(s => ({ size: s.size, duration: s.duration })));
          aTraf = box('traf', concat(aTfhd, aTfdt, aTrun));
        }

        moofBody = concat(mfhd, vTraf, aTraf);
        const moof = box('moof', moofBody);

        // mdat：按 traf 顺序排样本
        const mdatBody = concat(hasV ? vSampleBytes : new Uint8Array(0), hasA ? aSampleBytes : new Uint8Array(0));
        const mdat = box('mdat', mdatBody);
        const seg = concat(moof, mdat);

        // append 到对应 SourceBuffer（audio-only 模式不碰 videoSB）
        if (hasV && !self._audioOnlyMode && self._videoSB) {
          await self._appendQueue(seg, self._videoSB);
        }
        if (hasA && self._audioSB) {
          await self._appendQueue(seg, self._audioSB);
        }
      }

      try {
        let prevVideoTimeUs = null;
        let prevAudioTimeUs = null;
        while (this._streaming && !this._destroyed) {
          if (token !== this._streamToken) return; // 已被重置

          // 记录 cluster 起始文件偏移（读 ID 之前）
          const clusterElemStart = r.tell();
          // 读取 cluster 头
          const clusterId = await r.readVint();
          if (clusterId.value !== ID.CLUSTER) {
            // 可能是 Segment 末尾 padding，跳过
            break;
          }
          const clusterSize = await r.readVint();
          const clusterDataStart = r.tell();
          const clusterDataEnd = clusterDataStart + clusterSize.value;

          // 读 cluster timestamp（第一个子元素）
          let clusterTimeUs = 0;
          const subId = await r.readVint();
          const subSize = await r.readVint();
          if (subId.value === ID.TIMESTAMP) {
            const ts = await r.readUint(Math.min(8, subSize.value));
            clusterTimeUs = Math.round(ts * this._timecodeScale / 1000); // ns -> us
          } else {
            r._pos += subSize.value;
          }

          // 记录 cluster 索引（用于音轨切换/seek 时定位文件偏移）
          this._clusters.push({ fileOffset: clusterElemStart, timecodeUs: clusterTimeUs });

          // 逐个 SimpleBlock / BlockGroup
          while (r.tell() < clusterDataEnd) {
            if (token !== this._streamToken) return;
            const bId = await r.readVint();
            const bSize = await r.readVint();
            const bStart = r.tell();
            const bEnd = bStart + bSize.value;

            if (bId.value === ID.SIMPLE_BLOCK || bId.value === ID.BLOCK) {
              // 直接解析 SimpleBlock 数据区间
              const frame = await this._parseBlockAt(r, bStart, bEnd, clusterTimeUs);
              if (frame) {
                // 计算该帧 duration：与同 track 上一帧时间戳的差
                if (frame.trackNum === this._tracks.video.trackNum) {
                  if (!this._audioOnlyMode) {
                    if (prevVideoTimeUs != null && frame.timeUs > prevVideoTimeUs) {
                      frame.durationUs = frame.timeUs - prevVideoTimeUs;
                    }
                    prevVideoTimeUs = frame.timeUs;
                    vSamples.push({ size: frame.data.length, duration: frame.durationUs, key: frame.key });
                    vSampleBytes = concat(vSampleBytes, frame.data);
                    if (chunkStartUs == null) chunkStartUs = frame.timeUs;
                  } else {
                    prevVideoTimeUs = frame.timeUs; // audio-only 模式仍推进时间轴，但不 append
                  }
                } else {
                  const audioTrackNum = this._tracks.audios[this._currentAudioIdx].trackNum;
                  if (frame.trackNum === audioTrackNum) {
                    if (prevAudioTimeUs != null && frame.timeUs > prevAudioTimeUs) {
                      frame.durationUs = frame.timeUs - prevAudioTimeUs;
                    }
                    prevAudioTimeUs = frame.timeUs;
                    aSamples.push({ size: frame.data.length, duration: frame.durationUs });
                    aSampleBytes = concat(aSampleBytes, frame.data);
                    if (chunkStartUs == null) chunkStartUs = frame.timeUs;
                  }
                }
              }
            } else if (bId.value === ID.BLOCK_GROUP) {
              // BlockGroup：找里面的 Block 子元素
              while (r.tell() < bEnd) {
                const gId = await r.readVint();
                const gSize = await r.readVint();
                const gs = r.tell();
                const ge = gs + gSize.value;
                if (gId.value === ID.BLOCK) {
                  const frame = await this._parseBlockAt(r, gs, ge, clusterTimeUs);
                  if (frame) {
                    if (frame.trackNum === this._tracks.video.trackNum) {
                      if (!this._audioOnlyMode) {
                        if (prevVideoTimeUs != null && frame.timeUs > prevVideoTimeUs) frame.durationUs = frame.timeUs - prevVideoTimeUs;
                        prevVideoTimeUs = frame.timeUs;
                        vSamples.push({ size: frame.data.length, duration: frame.durationUs, key: frame.key });
                        vSampleBytes = concat(vSampleBytes, frame.data);
                        if (chunkStartUs == null) chunkStartUs = frame.timeUs;
                      } else {
                        prevVideoTimeUs = frame.timeUs;
                      }
                    } else {
                      const audioTrackNum = this._tracks.audios[this._currentAudioIdx].trackNum;
                      if (frame.trackNum === audioTrackNum) {
                        if (prevAudioTimeUs != null && frame.timeUs > prevAudioTimeUs) frame.durationUs = frame.timeUs - prevAudioTimeUs;
                        prevAudioTimeUs = frame.timeUs;
                        aSamples.push({ size: frame.data.length, duration: frame.durationUs });
                        aSampleBytes = concat(aSampleBytes, frame.data);
                        if (chunkStartUs == null) chunkStartUs = frame.timeUs;
                      }
                    }
                  }
                }
                r._pos = ge;
              }
            } else {
              r._pos += bSize.value;
            }

            // 攒够一个 chunk 就 flush 成 moof+mdat
            if (vSampleBytes.length >= CHUNK_VIDEO_BYTES || aSampleBytes.length >= 256 * 1024) {
              await flushChunk();
              vSamples = []; aSamples = [];
              vSampleBytes = new Uint8Array(0);
              aSampleBytes = new Uint8Array(0);
              chunkStartUs = null;
              // 背压：缓冲太多就等一下
              await this._drainBackpressure();
            }
          }
          // cluster 结束
          r._pos = clusterDataEnd;

          // 音频补轨模式：读到视频缓冲末尾就切回双轨
          if (this._audioOnlyMode && this._videoEl) {
            try {
              const vBuff = this._videoEl.buffered;
              if (vBuff.length > 0) {
                const vEnd = vBuff.end(vBuff.length - 1);
                if (clusterTimeUs / 1e6 >= vEnd - 0.5) {
                  this._audioOnlyMode = false;
                  console.log('[MSE-MKV] 音频追赶完成，恢复双轨流式');
                }
              }
            } catch (e) {}
          }
        }
        // 末尾 flush 剩余
        await flushChunk();
        // 全部读完，endOfStream
        if (!this._destroyed && !this._ended) {
          this._ended = true;
          try { this._ms.endOfStream(); } catch (e) {}
        }
      } catch (e) {
        if (this._destroyed || (e && e.name === 'AbortError')) return;
        console.warn('[MSE-MKV] 流式循环异常', e);
        // 触发回退
        try { this._videoEl.dispatchEvent(new Event('error')); } catch (_) {}
      }
    }

    /** 在已知 block 数据区间 [bs, be) 解析 SimpleBlock 帧
     *  bs/be 是 block 数据在窗口中的绝对边界。本函数从当前位置读 TrackNumber/TC/flags/data。 */
    async _parseBlockAt(r, bs, be, clusterTimeUs) {
      const tn = await r.readVint();
      const trackNum = tn.value;
      const relTc = await r.readInt(2);
      const flags = await r.readUint(1);
      const isKey = (flags & 0x80) !== 0;
      const frameTimeUs = clusterTimeUs + Math.round(relTc * this._timecodeScale / 1000);
      const data = await r.readBytes(be - r.tell());
      // 转换 H.264 Annex-B -> AVCC length-prefixed（AAC 不需要转，直接用）
      let outData = data;
      if (trackNum === this._tracks.video.trackNum) {
        outData = this._annexBToAvcc(data);
      }
      // duration：用下一帧时间减。这里先粗略按 1/30s（视频）或 AAC frame 时长
      let durationUs;
      if (trackNum === this._tracks.video.trackNum) {
        durationUs = 33367; // 默认 ~30fps，后面不精确但 MSE 会按时间轴对齐
      } else {
        const sr = this._tracks.audios[0].sampleRate || 44100;
        durationUs = Math.round(1024 * 1000000 / sr);
      }
      return { trackNum, timeUs: frameTimeUs, key: isKey, data: outData, durationUs };
    }

    /** Annex-B (00 00 00 01 / 00 00 01) -> AVCC (4-byte length prefix) */
    _annexBToAvcc(data) {
      // 找到所有 start code 边界
      const n = data.length;
      const starts = [];
      let i = 0;
      // 找 00 00 01 (3字节) 或 00 00 00 01 (4字节)
      while (i < n - 3) {
        if (data[i] === 0 && data[i + 1] === 0) {
          if (data[i + 2] === 1) { starts.push({ i, len: 3 }); i += 3; continue; }
          if (i + 3 < n && data[i + 2] === 0 && data[i + 3] === 1) { starts.push({ i, len: 4 }); i += 4; continue; }
        }
        i++;
      }
      if (starts.length === 0) return data; // 已经是 AVCC？
      // 构造 AVCC：每个 NAL = 4字节长度 + 数据
      let total = 0;
      const nalRanges = [];
      for (let k = 0; k < starts.length; k++) {
        const s = starts[k].i + starts[k].len;
        const e = (k + 1 < starts.length) ? starts[k + 1].i : n;
        const len = e - s;
        nalRanges.push({ s, e, len });
        total += 4 + len;
      }
      const out = new Uint8Array(total);
      const dv = new DataView(out.buffer);
      let o = 0;
      for (const nr of nalRanges) {
        dv.setUint32(o, nr.len);
        out.set(data.subarray(nr.s, nr.e), o + 4);
        o += 4 + nr.len;
      }
      return out;
    }

    /** 在 cluster 索引里二分查找 timeSec 对应的 cluster 文件偏移 */
    _findClusterAt(timeSec) {
      if (this._clusters.length === 0) return this._firstClusterOffset || 0;
      const targetUs = timeSec * 1e6;
      let lo = 0, hi = this._clusters.length - 1, best = 0;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (this._clusters[mid].timecodeUs <= targetUs) { best = mid; lo = mid + 1; }
        else hi = mid - 1;
      }
      return this._clusters[best].fileOffset;
    }

    /** 背压控制：缓冲太多就等 */
    async _drainBackpressure() {
      const v = this._videoEl;
      if (!v) return;
      try {
        const buffered = v.buffered;
        if (buffered.length === 0) return;
        const end = buffered.end(buffered.length - 1);
        const ahead = end - (v.currentTime || 0);
        if (ahead > 30) {
          // 缓冲超过 30 秒，等到 ahead < 15 秒再继续
          await new Promise((resolve) => {
            const check = () => {
              const b = v.buffered;
              if (b.length === 0) return resolve();
              const e = b.end(b.length - 1);
              if (e - (v.currentTime || 0) < 15 || this._destroyed) return resolve();
              setTimeout(check, 500);
            };
            check();
          });
        }
      } catch (e) {}
    }

    /** 串行 appendBuffer，等 updateend */
    async _appendQueue(data, sb) {
      if (!sb || this._destroyed) return;
      await this._whenDone(sb);
      if (this._destroyed) return;
      return new Promise((resolve, reject) => {
        const onUpdate = () => {
          sb.removeEventListener('updateend', onUpdate);
          sb.removeEventListener('error', onErr);
          resolve();
        };
        const onErr = (e) => {
          sb.removeEventListener('updateend', onUpdate);
          sb.removeEventListener('error', onErr);
          reject(e);
        };
        sb.addEventListener('updateend', onUpdate);
        sb.addEventListener('error', onErr);
        try {
          sb.appendBuffer(data);
        } catch (e) {
          onErr(e);
        }
      });
    }

    _whenDone(sb) {
      if (!sb || !sb.updating) return Promise.resolve();
      return new Promise((resolve) => {
        const onUpdate = () => {
          if (!sb.updating) {
            sb.removeEventListener('updateend', onUpdate);
            resolve();
          }
        };
        sb.addEventListener('updateend', onUpdate);
      });
    }
  }

  // 修复 _parseBlockAt 的调用：流式循环里直接用 _parseBlockAt
  // （上面 _parseBlock 占位不用，真正解析走 _parseBlockAt）

  global.MkvMsePlayer = MkvMsePlayer;
})(window);
