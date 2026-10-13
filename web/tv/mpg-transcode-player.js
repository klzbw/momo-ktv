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

      // video.captureStream → MediaStreamAudioSource
      const stream = this.video.captureStream ? this.video.captureStream() : this.video.mozCaptureStream();
      const src = this.audioCtx.createMediaStreamSource(stream);

      // 分左右声道
      this.splitNode = this.audioCtx.createChannelSplitter(2);
      src.connect(this.splitNode);

      // 左声道=原唱, 右声道=伴唱
      this.vocalGain = this.audioCtx.createGain();
      this.accGain = this.audioCtx.createGain();
      this.splitNode.connect(this.vocalGain, 0); // channel 0 = left
      this.splitNode.connect(this.accGain, 1);   // channel 1 = right

      // 合到立体声输出
      const merger = this.audioCtx.createChannelMerger(2);
      this.vocalGain.connect(merger, 0, 0); // vocal → out left
      this.accGain.connect(merger, 0, 1);   // acc → out right
      merger.connect(this.audioCtx.destination);

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
      try { if (this.audioCtx) this.audioCtx.close(); } catch (e) {}
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
