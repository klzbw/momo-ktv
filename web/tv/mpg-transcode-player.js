/**
 * mpg-transcode-player.js — MPG (MPEG-PS) server 转码播放器
 *
 * 浏览器原生不支持 MPEG-PS/MPEG-2/MP2，此播放器走 server ffmpeg 实时转码：
 *   server /api/cloud/transcode-mpg/:acct/* → ffmpeg 拉 115 CDN → H.264+AAC fMP4
 *   → MSE 喂 <video>
 *
 * 双音轨：server 用 join filter 把 track0(原唱) 放左声道、track1(伴唱) 放右声道。
 * 前端 WebAudio ChannelSplitter 分左右 → 两个 GainNode → 0-100 滑块切换。
 *
 * 暴露：window.MpgTranscodePlayer
 *
 * 用法：
 *   const p = new MpgTranscodePlayer();
 *   p.attachMedia(videoEl);
 *   await p.load('/api/cloud/transcode-mpg/3/path/to/song.mpg?dual=1');
 *   p.setVocalBalance(0);  // 0=原唱 100=伴唱
 *   p.destroy();
 */
(function (global) {
  'use strict';

  class MpgTranscodePlayer {
    constructor() {
      this.ms = null;
      this.sb = null;
      this.video = null;
      this.reader = null;
      this.abort = null;
      this.audioCtx = null;
      this.vocalGain = null;  // 左声道=原唱
      this.accGain = null;    // 右声道=伴唱
      this.splitNode = null;
      this.connected = false;
      this.loading = false;
      this.balance = 0; // 0=原唱 100=伴唱
    }

    attachMedia(videoEl) {
      this.video = videoEl;
    }

    async load(url) {
      if (!this.video) throw new Error('attachMedia first');
      this.loading = true;
      this.abort = new AbortController();

      console.log('[MPG-TC] load', url);

      this.ms = new MediaSource();
      this.video.src = URL.createObjectURL(this.ms);

      await new Promise((resolve, reject) => {
        this.ms.addEventListener('sourceopen', async () => {
          try {
            const mime = 'video/mp4; codecs="avc1.42E01E,mp4a.40.2"';
            if (!MediaSource.isTypeSupported(mime)) {
              throw new Error('MSE not supported: ' + mime);
            }
            this.sb = this.ms.addSourceBuffer(mime);
            this.sb.mode = 'segments';
            this.sb.addEventListener('updateend', () => this._pump());

            console.log('[MPG-TC] MSE open, fetching transcode stream...');
            const resp = await fetch(url, { signal: this.abort.signal });
            if (!resp.ok) throw new Error('HTTP ' + resp.status);
            if (!resp.body) throw new Error('no body');

            this.reader = resp.body.getReader();
            this.loading = false;
            this._pump();
            resolve();
          } catch (e) {
            console.error('[MPG-TC] load error:', e);
            reject(e);
          }
        }, { once: true });
      });

      // 等元数据到了建 WebAudio 左右声道切换
      this.video.addEventListener('loadedmetadata', () => {
        try { this._setupAudioBalance(); } catch (e) { console.warn('[MPG-TC] audio balance setup failed', e); }
      }, { once: true });
    }

    _pump() {
      if (!this.sb || this.sb.updating || !this.reader || this.abort.signal.aborted) return;
      this.reader.read().then(({ done, value }) => {
        if (done || this.abort.signal.aborted) return;
        try {
          this.sb.appendBuffer(value);
        } catch (e) {
          // Buffer full 或 pending，稍后再试
          setTimeout(() => this._pump(), 50);
        }
      }).catch(() => {});
    }

    _setupAudioBalance() {
      if (this.connected || !this.video) return;
      const Ctx = global.AudioContext || global.webkitAudioContext;
      this.audioCtx = new Ctx();
      // 【修复 2026-10-22】AudioContext 若在无用户手势时创建会处于 suspended，
      // 先主动 resume 一次；仍被拦时由页面全局手势(click/keydown)兜底 resume。
      if (this.audioCtx.state === 'suspended') {
        this.audioCtx.resume().catch(() => {});
      }

      // video.captureStream → MediaStreamSource（桌面 Chrome/Android 路径）
      // 【iOS 修复 2026-10-22】iOS Safari 的 HTMLVideoElement 没有 captureStream()，
      // 若不分支会直接抛 TypeError 导致无声。iOS 回退到 createMediaElementSource：
      // 它在 iOS Safari 受支持，把 video 输出接管进同一张 WebAudio 图。
      // 注意：MediaElementSource 会尊重元素自身的 muted/volume（与 captureStream 不同），
      // 而 loadSong 起播前把 video 设成了 muted=true/volume=0，这里必须显式还原，
      // 否则进 WebAudio 图的就是静音信号。桌面路径走 captureStream，不受影响。
      let src = null;
      let viaMediaElementSource = false;
      try {
        if (this.video.captureStream) {
          const stream = this.video.captureStream();
          src = this.audioCtx.createMediaStreamSource(stream);
        } else if (this.video.mozCaptureStream) {
          const stream = this.video.mozCaptureStream();
          src = this.audioCtx.createMediaStreamSource(stream);
        } else {
          viaMediaElementSource = true;
        }
      } catch (e) {
        console.warn('[MPG-TC] captureStream failed, fallback to MediaElementSource:', e && e.message);
        viaMediaElementSource = true;
      }
      if (viaMediaElementSource && !src) {
        try {
          try { this.video.muted = false; this.video.volume = 1; } catch (e) {}
          // 【iOS 跨歌修复】MediaElementSource 与 AudioContext 终身绑定同一 video 元素，
          // 切歌后再次 createMediaElementSource(同一 video) 会抛 InvalidStateError，导致第二首起
          // 竖条失效。改为共享全局 ctx + 缓存 node：切歌只重建 split/gains，不重复接线/不 close ctx。
          if (!global.__momoIosCtx || global.__momoIosCtx.state === 'closed') {
            global.__momoIosCtx = new Ctx();
          }
          this.audioCtx = global.__momoIosCtx;
          if (this.audioCtx.state === 'suspended') this.audioCtx.resume().catch(() => {});
          if (this.video._momoMesNode) {
            src = this.video._momoMesNode;
          } else {
            src = this.audioCtx.createMediaElementSource(this.video);
            this.video._momoMesNode = src;
          }
        } catch (e) {
          // 最后兜底：连 MediaElementSource 都失败（极老 WebKit），不接 WebAudio，
          // video 原生直出（左右声道混合），至少有声、不静默崩溃。
          console.warn('[MPG-TC] createMediaElementSource 也不可用，原生直出声:', e && e.message);
          this.connected = false;
          return;
        }
      }

      // 分左右声道
      this.splitNode = this.audioCtx.createChannelSplitter(2);
      src.connect(this.splitNode);

      // 左声道=原唱(track0), 右声道=伴唱(track1)，各自降为 mono 信号
      this.vocalGain = this.audioCtx.createGain();
      this.accGain = this.audioCtx.createGain();
      this.splitNode.connect(this.vocalGain, 0); // channel 0 = left(vocal)
      this.splitNode.connect(this.accGain, 1);   // channel 1 = right(acc)

      // 【修复 2026-10-22 单耳bug】旧实现 vocal→L / acc→R 固定映射：
      //   balance=0 时只有左耳(原唱)有声，右耳静音，听起来"只有一只耳朵"，
      //   且声像固定在左右两侧，切换像左右跳。
      // 新实现：mono 原唱/伴唱各自直连 destination，浏览器按 speakers 布局自动
      //   upmix mono→stereo，双耳同时听到同一内容；滑块 0↔100 在"双耳原唱"与
      //   "双耳伴唱"之间交叉淡入（无限滑动调人声语义）。
      this.vocalGain.connect(this.audioCtx.destination);
      this.accGain.connect(this.audioCtx.destination);

      this.connected = true;
      this._applyBalance();
      console.log('[MPG-TC] audio balance ready (left=vocal, right=acc)');
    }

    /**
     * @param {number} v 0=原唱 100=伴唱
     */
    setVocalBalance(v) {
      this.balance = Math.max(0, Math.min(100, v));
      this._applyBalance();
    }

    /** 当前人声平衡 0=原唱 100=伴唱（供 UI 竖条显示） */
    getBalance() { return this.balance; }

    /** 【iOS 修复 2026-10-22】用户手势内调用：resume 本播放器的 AudioContext。
     *  _setupAudioBalance 在 loadedmetadata 里异步建 ctx，iOS 上此时必为 suspended，
     *  页面全局手势监听会转调这里解锁出声；安全起见幂等。 */
    unlockAudio() {
      try {
        if (this.audioCtx && this.audioCtx.state === 'suspended') {
          this.audioCtx.resume().catch(() => {});
        }
        if (this.video && this.video.paused && !this.video.ended) {
          const pr = this.video.play && this.video.play();
          if (pr && pr.catch) pr.catch(() => {});
        }
      } catch (e) {}
    }

    _applyBalance() {
      if (!this.connected || !this.vocalGain) return;
      const t = this.balance / 100; // 0=全原唱, 1=全伴唱
      // 交叉淡入淡出
      this.vocalGain.gain.value = 1 - t;
      this.accGain.gain.value = t;
    }

    destroy() {
      try { this.abort.abort(); } catch (e) {}
      try { if (this.reader) this.reader.cancel(); } catch (e) {}
      try { if (this.sb) this.sb.abort(); } catch (e) {}
      try { if (this.ms && this.ms.readyState === 'open') this.ms.endOfStream(); } catch (e) {}
      try { if (this.video) this.video.removeAttribute('src'); } catch (e) {}
      // 【iOS 跨歌修复】切歌时断开上一首 split/gains，否则旧图仍从共享 MediaElementSource
      // 节点拉流直出 destination，造成新旧混音叠加。共享 iOS ctx 不 close（终身复用）。
      try { if (this.splitNode) this.splitNode.disconnect(); } catch (e) {}
      try { if (this.vocalGain) this.vocalGain.disconnect(); } catch (e) {}
      try { if (this.accGain) this.accGain.disconnect(); } catch (e) {}
      try { if (this.audioCtx && this.audioCtx !== global.__momoIosCtx) this.audioCtx.close(); } catch (e) {}
      this.connected = false;
      this.ms = null;
      this.sb = null;
      this.reader = null;
      this.audioCtx = null;
      this.vocalGain = null;
      this.accGain = null;
    }
  }

  global.MpgTranscodePlayer = MpgTranscodePlayer;
  console.log('[MPG-TC] mpg-transcode-player.js loaded');
})(window);
