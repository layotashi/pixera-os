/**
 * @module core/audio
 * audio.js — オーディオ基盤 (OS レベル)
 *
 * SYNESTA の全アプリが共有するオーディオインフラストラクチャ。
 * Web Audio API の AudioContext・マスター信号チェーン・録画用ストリームを
 * 一元管理し、SynthChannel クラスで per-channel 音声合成を提供する。
 *
 * 位置づけ:
 *   gpu.js が描画基盤であるように、audio.js は音声基盤である。
 *   Windows の WASAPI / Mac の CoreAudio に相当するレイヤー。
 *   STUDIO (DAW) 固有のスケジューラ・UI は audio/ に残る。
 *
 * ── 音声合成 (SynthChannel) ──
 *   波形: SAW, TRI, SQ50, SQ25, SQ12, SINE, NOISE
 *   簡易 ADSR エンベロープ付き。発音位相 (startPhase) 制御可能。
 *   SynthChannel クラスで per-channel 状態を管理。
 *
 * ── サンプル再生 (SamplePlayer) ──
 *   AudioBuffer (PCM データ) のワンショット再生。
 *   システム SFX や STUDIO Sampler デバイスの基盤。
 *   decodeAudioBuffer() で ArrayBuffer → AudioBuffer に変換し、
 *   SamplePlayer で再生する。
 *
 * AudioContext / マスターチェーンは共有。後方互換 API はデフォルトチャンネルにデリゲート。
 *
 * 録画用音声キャプチャ:
 *   limiter 出力を MediaStreamDestination にも接続。
 *   getAudioStream() で録画用 MediaStream を取得可能。
 */

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  音楽ユーティリティ (定数・変換関数)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** A4 (MIDI 69) の基準周波数 (Hz) */
const A4_FREQ = 440;

/** A4 の MIDI ノート番号 */
const A4_MIDI = 69;

/** 1 オクターブあたりの半音数 */
const SEMITONES_PER_OCTAVE = 12;

/** 音名テーブル (C〜B) */
export const NOTE_NAMES = [
  "C",
  "C#",
  "D",
  "D#",
  "E",
  "F",
  "F#",
  "G",
  "G#",
  "A",
  "A#",
  "B",
];

/**
 * MIDI ノート番号から周波数 (Hz) を計算する。
 * 12 平均律: freq = 440 × 2^((midiNote − 69) / 12)
 *
 * @param {number} midiNote  MIDI ノート番号 (0–127)
 * @returns {number} 周波数 (Hz)
 */
export function midiToFreq(midiNote) {
  return A4_FREQ * Math.pow(2, (midiNote - A4_MIDI) / SEMITONES_PER_OCTAVE);
}

/**
 * MIDI ノート番号から音名文字列を返す。
 * 例: 60 → "C4", 69 → "A4"
 *
 * @param {number} midiNote  MIDI ノート番号 (0–127)
 * @returns {string} "音名 + オクターブ" (例: "C#3")
 */
export function midiToNoteName(midiNote) {
  const name = NOTE_NAMES[midiNote % SEMITONES_PER_OCTAVE];
  const octave = Math.floor(midiNote / SEMITONES_PER_OCTAVE) - 1;
  return `${name}${octave}`;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  共有リソース
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** @type {AudioContext|null} */
let ctx = null;

/** マスター音量ノード (全チャンネル共通バス) */
let masterGain = null;

/** 録画用 MediaStreamDestination (limiter → mediaDest) */
let mediaDest = null;

/** ノイズ用バッファ (全チャンネル共有) */
let noiseBuffer = null;

/** PeriodicWave に渡す Fourier 係数の倍音上限。
 *  最低音 A0 (27.5Hz) でも Nyquist (24kHz @ 48kHz sr) まで ~872 倍音必要なので
 *  1024 を確保。OscillatorNode が発音周波数ごとに Nyquist 以上を自動カット。 */
const PERIODIC_WAVE_HARMONICS = 1024;

/** anti-click フェード用タイムコンスタント (2ms) */
const FADE_TIME_CONSTANT = 0.002;

/** フェード後のテール時間 (source.stop までの余裕) */
const FADE_TAIL = 0.01;

/** 波形名リスト (順送り用) */
export const WAVEFORM_LIST = [
  "saw",
  "tri",
  "sq50",
  "sq25",
  "sq12",
  "sine",
  "noise",
];

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  波形生成 (唯一の波形定義)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * 波形の 1 サンプルを計算する。
 * プレビューとオーディオバッファの両方がこの関数を使用する。
 * @param {string} wf  波形タイプ
 * @param {number} t   位相 0.0〜1.0
 * @returns {number}   -1.0〜+1.0
 */
export function sampleWaveformFn(wf, t) {
  switch (wf) {
    case "saw":
      return 1 - 2 * t;
    case "tri":
      return t < 0.25 ? 4 * t : t < 0.75 ? 2 - 4 * t : 4 * t - 4;
    case "sq50":
      return t < 0.5 ? 1 : -1;
    case "sq25":
      return t < 0.25 ? 1 : -1;
    case "sq12":
      return t < 0.125 ? 1 : -1;
    case "sine":
      return Math.sin(2 * Math.PI * t);
    case "noise":
      return Math.random() * 2 - 1;
    default:
      return 0;
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  Fourier 係数 (帯域制限合成用)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * 波形 `wf` の n 番目倍音の Fourier 係数 (a_n, b_n) を返す。
 * 規約: f(t) = real[0] + Σ_{n=1}^∞ [a_n cos(2πnt) + b_n sin(2πnt)]
 *
 * sampleWaveformFn と同じ波形になるよう解析的に算出している
 * (= 鋸/三角/矩形/正弦/任意 duty パルスの古典的閉形式)。
 *
 * SynthChannel の PeriodicWave 生成と playback_engine.renderToBuffer の
 * 帯域制限オフラインレンダリングの両方がこの関数を使う。
 * @param {string} wf
 * @param {number} n  倍音番号 (1 以上)
 * @returns {{ a: number, b: number }}
 */
export function fourierCoeff(wf, n) {
  switch (wf) {
    case "saw":
      // f(t) = 1 - 2t → b_n = 2/(πn), a_n = 0
      return { a: 0, b: 2 / (Math.PI * n) };
    case "tri": {
      // 偶数倍音 0、奇数倍音 (8/π²n²)·(-1)^((n-1)/2)
      if (n % 2 === 0) return { a: 0, b: 0 };
      const sign = ((n - 1) / 2) % 2 === 0 ? 1 : -1;
      return { a: 0, b: (8 * sign) / (Math.PI * Math.PI * n * n) };
    }
    case "sq50": {
      // 偶数倍音 0、奇数倍音 4/(πn)
      if (n % 2 === 0) return { a: 0, b: 0 };
      return { a: 0, b: 4 / (Math.PI * n) };
    }
    case "sq25": {
      // Duty 25%: a_n = 2sin(πn/2)/(πn), b_n = 2(1-cos(πn/2))/(πn)
      const k = (Math.PI * n) / 2;
      return {
        a: (2 * Math.sin(k)) / (Math.PI * n),
        b: (2 * (1 - Math.cos(k))) / (Math.PI * n),
      };
    }
    case "sq12": {
      // Duty 12.5%
      const k = (Math.PI * n) / 4;
      return {
        a: (2 * Math.sin(k)) / (Math.PI * n),
        b: (2 * (1 - Math.cos(k))) / (Math.PI * n),
      };
    }
    case "sine":
      return n === 1 ? { a: 0, b: 1 } : { a: 0, b: 0 };
    default:
      return { a: 0, b: 0 };
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  初期化
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * AudioContext を生成し共有マスターチェーンを構築する。
 * ブラウザのオートプレイポリシーにより、ユーザー操作後に呼ぶ必要がある。
 */
export function initAudio() {
  if (ctx) return;
  ctx = new AudioContext();

  // ── マスター信号チェーン ──
  // channelGain (per-ch) → masterGain → dcBlocker (HP 20Hz) → limiter → destination
  masterGain = ctx.createGain();
  masterGain.gain.value = 1.0;

  // DC ブロッキングフィルタ (パルス波の DC 成分を除去)
  const dcBlocker = ctx.createBiquadFilter();
  dcBlocker.type = "highpass";
  dcBlocker.frequency.value = 20;
  dcBlocker.Q.value = 0.707; // Butterworth

  // ブリックウォールリミッター (クリッピング防止)
  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = -0.3;
  limiter.knee.value = 0;
  limiter.ratio.value = 20;
  limiter.attack.value = 0.001;
  limiter.release.value = 0.05;

  masterGain.connect(dcBlocker);
  dcBlocker.connect(limiter);
  limiter.connect(ctx.destination);

  // ── 録画用ストリーム出力 ──
  mediaDest = ctx.createMediaStreamDestination();
  limiter.connect(mediaDest);

  // ── ノイズバッファ生成 (4秒 + ループ接合クロスフェード) ──
  const sr = ctx.sampleRate;
  const len = sr * 4;
  noiseBuffer = ctx.createBuffer(1, len, sr);
  const data = noiseBuffer.getChannelData(0);
  for (let i = 0; i < len; i++) {
    data[i] = Math.random() * 2 - 1;
  }
  // ループ接合点のクロスフェード (10ms) でクリック除去
  const fadeLen = Math.floor(sr * 0.01);
  for (let i = 0; i < fadeLen; i++) {
    const t = i / fadeLen;
    data[len - fadeLen + i] = data[len - fadeLen + i] * (1 - t) + data[i] * t;
  }
}

/**
 * AudioContext を取得する。スケジューラが currentTime を参照するために使用。
 * @returns {AudioContext|null}
 */
export function getAudioContext() {
  return ctx;
}

/**
 * DC ブロッカ（一極ハイパス）。純関数——書き出しなどのオフライン処理向け。
 * 再生時のマスターチェーン（initAudio の dcBlocker: HP 20Hz）と同じ意図で、非対称
 * パルス波（duty≠.5、例: pulse(f,.25) は DC≈-0.5）が持つ 0Hz 成分を除く。DC が残ると
 * ヘッドルームを浪費し、ピークが片側に寄って AAC で歪みやすい（＝再生と違う音になる）。
 * @param {Float32Array} samples  入力（不変）
 * @param {number} sampleRate
 * @param {number} [cutoffHz=20]  マスターチェーンと同じ 20Hz
 * @returns {Float32Array} 新しい配列
 */
export function dcBlock(samples, sampleRate, cutoffHz = 20) {
  const n = samples.length;
  const out = new Float32Array(n);
  const R = 1 - (2 * Math.PI * cutoffHz) / sampleRate; // 一極係数（≈0.997 @20Hz/44.1k）
  let x1 = 0,
    y1 = 0;
  for (let i = 0; i < n; i++) {
    const x = samples[i];
    const y = x - x1 + R * y1; // 標準 DC ブロッカ y[n]=x[n]-x[n-1]+R·y[n-1]
    out[i] = y;
    x1 = x;
    y1 = y;
  }
  return out;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  SynthChannel クラス
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * モノフォニック・シンセチャンネル。
 * 波形・ADSR・音量・位相など全パラメータをインスタンスごとに保持する。
 * 信号チェーン: envGain → channelGain → masterGain → dcBlocker → limiter → dest
 */
export class SynthChannel {
  constructor() {
    /** @type {string} 波形タイプ */
    this._waveform = "saw";
    /** @type {number} 発音開始位相 (0.0〜1.0) */
    this._startPhase = 0;
    /** @type {number} ADSR Attack (秒) */
    this._adsrA = 0.01;
    /** @type {number} ADSR Decay (秒) */
    this._adsrD = 0.1;
    /** @type {number} ADSR Sustain (0.0〜1.0) */
    this._adsrS = 0.8;
    /** @type {number} ADSR Release (秒) */
    this._adsrR = 0.2;
    /** @type {number} チャンネル音量 (0.0〜1.0) */
    this._volume = 0.5;

    /** @type {AudioScheduledSourceNode|null} */
    this._currentSource = null;
    /** @type {GainNode|null} */
    this._currentEnvGain = null;
    /** @type {AudioScheduledSourceNode|null} */
    this._releasingSource = null;
    /** @type {GainNode|null} */
    this._releasingEnvGain = null;
    /** @type {PeriodicWave|null} non-noise 波形の帯域制限合成用 (OscillatorNode に渡す) */
    this._periodicWave = null;
    /** @type {Set<{source:AudioScheduledSourceNode, envGain:GainNode, endTime:number}>} */
    this._scheduledVoices = new Set();
    /** @type {GainNode|null} */
    this._channelGain = null;
  }

  /** チャンネルゲインノードを遅延生成する (AudioContext 初期化後に呼ばれる) */
  _ensureChannelGain() {
    if (!this._channelGain && ctx && masterGain) {
      this._channelGain = ctx.createGain();
      this._channelGain.gain.value = this._volume;
      this._channelGain.connect(masterGain);
    }
  }

  /**
   * 現在の波形と startPhase から PeriodicWave を生成する。
   * 非 noise 波形に対してのみ呼ばれる。
   *
   * 帯域制限: 倍音は PERIODIC_WAVE_HARMONICS (= 1024) まで含めるが、
   * OscillatorNode が発音周波数に応じて Nyquist 以上を自動的にカットするため、
   * 高音でもエイリアシングのない出力になる。
   *
   * startPhase は Fourier 係数の phase rotation で表現する:
   *   f(t + sp) を実現する係数 →
   *     new_a_n = a_n cos(2πn·sp) + b_n sin(2πn·sp)
   *     new_b_n = b_n cos(2πn·sp) − a_n sin(2πn·sp)
   *
   * real[0] (DC) は 0 のまま (sq25/sq12 等の DC オフセットは既存の
   * dcBlocker フィルタが後段で除去するため、AudioBuffer 実装時と最終出力が一致)。
   */
  _buildPeriodicWave() {
    if (!ctx || this._waveform === "noise") {
      this._periodicWave = null;
      return;
    }
    const N = PERIODIC_WAVE_HARMONICS;
    const real = new Float32Array(N + 1);
    const imag = new Float32Array(N + 1);
    const sp = this._startPhase;
    const usePhase = sp !== 0;

    for (let n = 1; n <= N; n++) {
      const { a, b } = fourierCoeff(this._waveform, n);
      if (!usePhase) {
        real[n] = a;
        imag[n] = b;
      } else {
        const phi = 2 * Math.PI * n * sp;
        const cosPhi = Math.cos(phi);
        const sinPhi = Math.sin(phi);
        real[n] = a * cosPhi + b * sinPhi;
        imag[n] = b * cosPhi - a * sinPhi;
      }
    }
    // disableNormalization: true で解析的振幅を保つ
    // (AudioBuffer 実装時と sq25/sq12 の音量感を揃えるため)
    this._periodicWave = ctx.createPeriodicWave(real, imag, {
      disableNormalization: true,
    });
  }

  /**
   * 現在の波形で AudioScheduledSourceNode を生成する。
   * - noise: AudioBufferSourceNode + ノイズバッファ (帯域制限不要)
   * - その他: OscillatorNode + PeriodicWave (ブラウザネイティブの帯域制限合成)
   * @param {number} freq  周波数 (Hz)
   * @param {number} time  開始時刻
   * @returns {AudioScheduledSourceNode}
   */
  _createSource(freq, time) {
    if (this._waveform === "noise") {
      const source = ctx.createBufferSource();
      source.buffer = noiseBuffer;
      source.loop = true;
      // ノイズ音程制御: A4 (440Hz) を基準に playbackRate でピッチを変化させる
      // 高音→ブライト (速い), 低音→ダーク (遅い)
      const rate = freq / 440;
      source.playbackRate.setValueAtTime(rate, time);
      return source;
    }
    if (!this._periodicWave) this._buildPeriodicWave();
    const source = ctx.createOscillator();
    source.setPeriodicWave(this._periodicWave);
    source.frequency.setValueAtTime(freq, time);
    return source;
  }

  /** 現在のノートを即座に停止する (anti-click 指数フェード付き) */
  _stopCurrent() {
    // リリース中のボイスをカット
    if (this._releasingEnvGain) {
      try {
        const now = ctx.currentTime;
        this._releasingEnvGain.gain.cancelScheduledValues(now);
        this._releasingEnvGain.gain.setTargetAtTime(
          0.001,
          now,
          FADE_TIME_CONSTANT,
        );
      } catch (_) {
        /* already stopped */
      }
      this._releasingSource = null;
      this._releasingEnvGain = null;
    }

    // 発音中のボイスをカット
    if (this._currentSource) {
      try {
        const now = ctx.currentTime;
        if (this._currentEnvGain) {
          this._currentEnvGain.gain.cancelScheduledValues(now);
          this._currentEnvGain.gain.setTargetAtTime(
            0.001,
            now,
            FADE_TIME_CONSTANT,
          );
        }
        const src = this._currentSource;
        const env = this._currentEnvGain;
        src.stop(now + FADE_TIME_CONSTANT * 5 + FADE_TAIL);
        src.onended = () => {
          try {
            src.disconnect();
            if (env) env.disconnect();
          } catch (_) {
            /* already disconnected */
          }
        };
      } catch (_) {
        /* already stopped */
      }
      this._currentSource = null;
      this._currentEnvGain = null;
    }
  }

  // ── ノートオン / オフ ──

  /**
   * ノートオン。現在発音中のノートは即座に停止して新しいノートを開始する。
   * @param {number} freq  周波数 (Hz)
   * @param {number} [time]  発音開始時刻 (AudioContext.currentTime ベース)
   * @param {number} [vel=1.0]  ベロシティ (0.0〜1.0)
   */
  noteOn(freq, time, vel) {
    if (!ctx) initAudio();
    if (ctx.state === "suspended") ctx.resume();
    this._ensureChannelGain();
    this._stopCurrent();

    const now = time !== undefined ? time : ctx.currentTime;
    const v = vel !== undefined ? Math.max(0, Math.min(1, vel)) : 1.0;

    // エンベロープ GainNode (Attack=リニア, Decay=指数)
    const envGain = ctx.createGain();
    if (this._adsrA < 0.001) {
      // Attack ≈ 0: 即座にピークへ (linearRamp の 0 秒問題を回避)
      envGain.gain.setValueAtTime(v, now);
    } else {
      envGain.gain.setValueAtTime(0.001, now);
      envGain.gain.linearRampToValueAtTime(v, now + this._adsrA);
    }
    envGain.gain.setTargetAtTime(
      Math.max(this._adsrS * v, 0.001),
      now + this._adsrA,
      Math.max(this._adsrD * 0.33, 0.001),
    );
    envGain.connect(this._channelGain);

    // ソースノード生成
    const source = this._createSource(freq, now);
    source.connect(envGain);
    source.start(now);

    this._currentSource = source;
    this._currentEnvGain = envGain;
  }

  /**
   * ノートオフ。Release エンベロープを適用して停止する。
   * @param {number} [time]  消音開始時刻 (AudioContext.currentTime ベース)
   */
  noteOff(time) {
    if (!ctx || !this._currentSource || !this._currentEnvGain) return;

    const now = time !== undefined ? time : ctx.currentTime;
    const env = this._currentEnvGain;
    const src = this._currentSource;

    // 指数リリース (現在値から漸近的に減衰)
    // cancelAndHoldAtTime: 現在値を保持してから減衰 (Attack途中のnoteOffでも安全)
    if (typeof env.gain.cancelAndHoldAtTime === "function") {
      env.gain.cancelAndHoldAtTime(now);
    } else {
      env.gain.cancelScheduledValues(now);
    }
    env.gain.setTargetAtTime(0.001, now, Math.max(this._adsrR * 0.33, 0.001));

    // source.stop + onended でクリーンアップ
    src.stop(now + this._adsrR + 0.05);
    const self = this;
    src.onended = () => {
      try {
        src.disconnect();
        env.disconnect();
      } catch (_) {
        /* already disconnected */
      }
      if (self._releasingSource === src) {
        self._releasingSource = null;
        self._releasingEnvGain = null;
      }
    };

    this._releasingSource = src;
    this._releasingEnvGain = env;
    this._currentSource = null;
    this._currentEnvGain = null;
  }

  // ── スケジュール済みボイス (トランスポート再生用) ──

  /**
   * 完全な 1 ノート分のボイスを Web Audio タイミングでスケジュールする。
   * @param {number} freq     周波数 (Hz)
   * @param {number} onTime   発音開始時刻 (AudioContext.currentTime ベース)
   * @param {number} offTime  発音終了時刻 (AudioContext.currentTime ベース)
   */
  scheduleVoice(freq, onTime, offTime) {
    if (!ctx) initAudio();
    if (ctx.state === "suspended") ctx.resume();
    this._ensureChannelGain();

    // ── モノフォニック: 新ボイスの開始と重なる既存ボイスをカット (anti-click フェード) ──
    for (const voice of this._scheduledVoices) {
      if (voice.endTime > onTime) {
        try {
          voice.envGain.gain.cancelScheduledValues(onTime);
          voice.envGain.gain.setTargetAtTime(0.001, onTime, 0.002);
        } catch (_) {
          /* already stopped */
        }
        voice.endTime = onTime;
      }
    }

    // ── エンベロープ GainNode ──
    const envGain = ctx.createGain();
    if (this._adsrA < 0.001) {
      envGain.gain.setValueAtTime(1, onTime);
    } else {
      envGain.gain.setValueAtTime(0.001, onTime);
      envGain.gain.linearRampToValueAtTime(1, onTime + this._adsrA);
    }
    envGain.gain.setTargetAtTime(
      Math.max(this._adsrS, 0.001),
      onTime + this._adsrA,
      Math.max(this._adsrD * 0.33, 0.001),
    );
    envGain.gain.setTargetAtTime(
      0.001,
      offTime,
      Math.max(this._adsrR * 0.33, 0.001),
    );
    envGain.connect(this._channelGain);

    // ── ソースノード ──
    const source = this._createSource(freq, onTime);
    source.connect(envGain);
    source.start(onTime);
    source.stop(offTime + this._adsrR + 0.05);

    // ── クリーンアップ ──
    const voice = { source, envGain, endTime: offTime + this._adsrR + 0.05 };
    this._scheduledVoices.add(voice);
    const voices = this._scheduledVoices;
    source.onended = () => {
      try {
        source.disconnect();
        envGain.disconnect();
      } catch (_) {
        /* already disconnected */
      }
      voices.delete(voice);
    };
  }

  /**
   * スケジュール済みの全ボイスを即座に停止する。
   * トランスポートの Stop / Pause 時に使用。
   */
  stopAllScheduled() {
    if (!ctx) return;
    const now = ctx.currentTime;
    for (const voice of this._scheduledVoices) {
      try {
        voice.envGain.gain.cancelScheduledValues(now);
        voice.envGain.gain.setTargetAtTime(0.001, now, 0.002);
        voice.source.stop(now + 0.015);
      } catch (_) {
        /* already stopped */
      }
    }
  }

  // ── パラメータ設定 ──

  /**
   * 波形タイプを設定する。
   * @param {"saw"|"tri"|"sq50"|"sq25"|"sq12"|"sine"|"noise"} type
   */
  setWaveform(type) {
    this._waveform = type;
    this._buildPeriodicWave();
  }

  /** @returns {string} 現在の波形タイプ */
  getWaveform() {
    return this._waveform;
  }

  /**
   * 波形を順送りで切り替え、新しい波形名を返す。
   * @returns {string} 切り替え後の波形名
   */
  cycleWaveform() {
    const idx = WAVEFORM_LIST.indexOf(this._waveform);
    this._waveform = WAVEFORM_LIST[(idx + 1) % WAVEFORM_LIST.length];
    this._buildPeriodicWave();
    return this._waveform;
  }

  /**
   * 発音開始位相を設定する。
   * @param {number} phase  0.0〜1.0
   */
  setStartPhase(phase) {
    this._startPhase = Math.max(0, Math.min(1, phase));
    this._buildPeriodicWave();
  }

  /** @returns {number} 現在の発音開始位相 (0.0〜1.0) */
  getStartPhase() {
    return this._startPhase;
  }

  /**
   * ADSR パラメータを設定する (単位: ミリ秒 / Sustain は 0〜100%)。
   */
  setADSR(a, d, s, r) {
    this._adsrA = a / 1000;
    this._adsrD = d / 1000;
    this._adsrS = s / 100;
    this._adsrR = r / 1000;
  }

  /** @returns {{ a:number, d:number, s:number, r:number }} ADSR (ms / %) */
  getADSR() {
    return {
      a: this._adsrA * 1000,
      d: this._adsrD * 1000,
      s: this._adsrS * 100,
      r: this._adsrR * 1000,
    };
  }

  /**
   * チャンネル音量を設定する。
   * @param {number} v  0〜100
   */
  setVolume(v) {
    this._volume = v / 100;
    if (this._channelGain) {
      this._channelGain.gain.setValueAtTime(this._volume, ctx.currentTime);
    }
  }

  /** @returns {number} 現在のチャンネル音量 (0〜100) */
  getVolume() {
    return this._volume * 100;
  }

  /**
   * 現在の波形の 1 周期分を n サンプルで返す (startPhase 適用済み)。
   * @param {number} n  サンプル数
   * @returns {Float32Array}  -1.0 〜 +1.0 の範囲
   */
  getWaveformSamples(n) {
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const t = (i / n + this._startPhase) % 1;
      out[i] = sampleWaveformFn(this._waveform, t);
    }
    return out;
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  デフォルトチャンネル + 後方互換 API
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** @type {SynthChannel|null} */
let _defaultChannel = null;

/** デフォルトチャンネルを取得する (遅延生成) */
export function getDefaultChannel() {
  if (!_defaultChannel) _defaultChannel = new SynthChannel();
  return _defaultChannel;
}

/** 新しいチャンネルを生成する (マルチトラック用) */
export function createChannel() {
  return new SynthChannel();
}

/**
 * デフォルトチャンネルの全パラメータを初期値にリセットする。
 * tracks[0].channel が直接参照を保持しているため、
 * インスタンスを置き換えずにインプレースで初期化する。
 */
export function resetDefaultChannel() {
  if (!_defaultChannel) return;
  _defaultChannel._stopCurrent();
  _defaultChannel.stopAllScheduled();
  _defaultChannel._waveform = "saw";
  _defaultChannel._startPhase = 0;
  _defaultChannel._adsrA = 0.01;
  _defaultChannel._adsrD = 0.1;
  _defaultChannel._adsrS = 0.8;
  _defaultChannel._adsrR = 0.2;
  _defaultChannel._volume = 0.5;
  _defaultChannel._periodicWave = null;
  if (_defaultChannel._channelGain && ctx) {
    _defaultChannel._channelGain.gain.setValueAtTime(0.5, ctx.currentTime);
  }
}

// ── 後方互換エクスポート (デフォルトチャンネルにデリゲート) ──

export function noteOn(freq, time, vel) {
  getDefaultChannel().noteOn(freq, time, vel);
}

export function noteOff(time) {
  getDefaultChannel().noteOff(time);
}

// scheduleVoice / stopAllScheduled のモジュールレベルラッパーは廃止。
// トランスポート等は channel.scheduleVoice() / channel.stopAllScheduled() を直接呼ぶこと。

export function setWaveform(type) {
  getDefaultChannel().setWaveform(type);
}

export function getWaveform() {
  return getDefaultChannel().getWaveform();
}

export function cycleWaveform() {
  return getDefaultChannel().cycleWaveform();
}

export function setStartPhase(phase) {
  getDefaultChannel().setStartPhase(phase);
}

export function getStartPhase() {
  return getDefaultChannel().getStartPhase();
}

export function setADSR(a, d, s, r) {
  getDefaultChannel().setADSR(a, d, s, r);
}

export function setVolume(v) {
  getDefaultChannel().setVolume(v);
}

export function getWaveformSamples(n) {
  return getDefaultChannel().getWaveformSamples(n);
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  SFX ヘルパー
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * SFX チャンネル定義辞書からチャンネルマップを生成する。
 * ユーザーの初回操作後に呼ぶこと (AudioContext 制約)。
 *
 * @param {Object<string, {wave:string, adsr:[number,number,number,number], vol:number}>} defs
 * @returns {Object<string, SynthChannel>}
 *
 * @example
 * const sfx = createSfxChannels({
 *   hit:  { wave: "sq50",  adsr: [1, 40, 0, 20],  vol: 22 },
 *   die:  { wave: "noise", adsr: [1, 200, 0, 150], vol: 25 },
 * });
 * playSfx(sfx.hit, 60);
 */
export function createSfxChannels(defs) {
  const channels = {};
  for (const [name, def] of Object.entries(defs)) {
    const ch = new SynthChannel();
    ch.setWaveform(def.wave);
    ch.setADSR(...def.adsr);
    ch.setVolume(def.vol);
    channels[name] = ch;
  }
  return channels;
}

/**
 * SFX をワンショット再生する。
 * チャンネルが null/undefined なら何もしない (SFX 未初期化時の安全策)。
 *
 * noteOn + 即 noteOff は cancelAndHoldAtTime がアタックエンベロープを
 * キャンセルしてしまい無音になるため、scheduleVoice を使用して
 * 指定時間分の長さを持つワンショットボイスとしてスケジュールする。
 *
 * @param {SynthChannel|null|undefined} ch
 * @param {number} midiNote - MIDI ノート番号
 * @param {number} [duration] - 発音持続時間 (秒)。省略時は A+D から自動算出。
 */
export function playSfx(ch, midiNote, duration) {
  if (!ch) return;
  if (!ctx) initAudio();
  if (ctx.state === "suspended") ctx.resume();
  const now = ctx.currentTime;
  const freq = midiToFreq(midiNote);
  const dur = duration !== undefined
    ? duration
    : ch._adsrA + ch._adsrD + 0.001;
  ch.scheduleVoice(freq, now, now + dur);
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  SamplePlayer クラス — PCM サンプル再生
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * AudioBuffer (PCM データ) のワンショット再生プレイヤー。
 * SynthChannel が数式ベースの波形合成を担うのに対し、
 * SamplePlayer は事前にデコード済みの PCM バッファを再生する。
 *
 * 用途:
 *   - システム SFX (WAV ファイルベースの効果音)
 *   - STUDIO Sampler デバイス
 *   - ユーザーカスタム SFX (VFS 上の WAV を再生)
 *
 * 信号チェーン: source → gainNode → masterGain → ... → destination
 *
 * @example
 * const buf = await decodeAudioBuffer(wavArrayBuffer);
 * const player = new SamplePlayer(buf);
 * player.play();            // 原音ピッチで再生
 * player.play(2.0);         // 2 倍速 (1 オクターブ上)
 */
export class SamplePlayer {
  /**
   * @param {AudioBuffer|null} [buffer=null]  再生する AudioBuffer (後から setBuffer 可)
   * @param {number} [volume=0.5]  初期音量 (0.0〜1.0)
   */
  constructor(buffer = null, volume = 0.5) {
    /** @type {AudioBuffer|null} */
    this._buffer = buffer;
    /** @type {number} 音量 (0.0〜1.0) */
    this._volume = Math.max(0, Math.min(1, volume));
    /** @type {GainNode|null} masterGain への接続用 */
    this._gainNode = null;
    /**
     * アクティブなボイス。同時発音数の管理に使用。
     * @type {Set<AudioBufferSourceNode>}
     */
    this._activeVoices = new Set();
    /** @type {number} 最大同時発音数 (超過時は最古のボイスをカット) */
    this._maxVoices = 4;
  }

  /** GainNode を遅延生成し masterGain に接続する */
  _ensureGain() {
    if (!this._gainNode && ctx && masterGain) {
      this._gainNode = ctx.createGain();
      this._gainNode.gain.value = this._volume;
      this._gainNode.connect(masterGain);
    }
  }

  /**
   * AudioBuffer を差し替える。
   * @param {AudioBuffer|null} buffer
   */
  setBuffer(buffer) {
    this._buffer = buffer;
  }

  /** @returns {AudioBuffer|null} 現在のバッファ */
  getBuffer() {
    return this._buffer;
  }

  /**
   * 音量を設定する。
   * @param {number} v  0.0〜1.0
   */
  setVolume(v) {
    this._volume = Math.max(0, Math.min(1, v));
    if (this._gainNode && ctx) {
      this._gainNode.gain.setValueAtTime(this._volume, ctx.currentTime);
    }
  }

  /** @returns {number} 現在の音量 (0.0〜1.0) */
  getVolume() {
    return this._volume;
  }

  /**
   * 最大同時発音数を設定する。
   * @param {number} n  1 以上の整数
   */
  setMaxVoices(n) {
    this._maxVoices = Math.max(1, n | 0);
  }

  /**
   * サンプルをワンショット再生する。
   * バッファ未設定・AudioContext 未初期化時は何もしない。
   *
   * @param {number} [playbackRate=1.0]  再生速度 (1.0 = 原音, 2.0 = 1oct 上, 0.5 = 1oct 下)
   * @param {number} [time]  再生開始時刻 (AudioContext.currentTime ベース)
   */
  play(playbackRate, time) {
    if (!this._buffer) return;
    if (!ctx) initAudio();
    if (ctx.state === "suspended") ctx.resume();
    this._ensureGain();

    // 同時発音数制限: 超過分を古い順にカット
    while (this._activeVoices.size >= this._maxVoices) {
      const oldest = this._activeVoices.values().next().value;
      try {
        oldest.stop();
      } catch (_) {
        /* already stopped */
      }
      this._activeVoices.delete(oldest);
    }

    const now = time !== undefined ? time : ctx.currentTime;
    const source = ctx.createBufferSource();
    source.buffer = this._buffer;
    source.loop = false;
    if (playbackRate !== undefined && playbackRate !== 1.0) {
      source.playbackRate.setValueAtTime(playbackRate, now);
    }
    source.connect(this._gainNode);
    source.start(now);

    // クリーンアップ
    this._activeVoices.add(source);
    const voices = this._activeVoices;
    source.onended = () => {
      try {
        source.disconnect();
      } catch (_) {
        /* already disconnected */
      }
      voices.delete(source);
    };
  }

  /**
   * 全アクティブボイスを即座に停止する (anti-click フェード付き)。
   */
  stop() {
    if (!ctx) return;
    const now = ctx.currentTime;
    for (const source of this._activeVoices) {
      try {
        source.stop(now + FADE_TIME_CONSTANT * 5 + FADE_TAIL);
      } catch (_) {
        /* already stopped */
      }
    }
    // onended で Set からの除去は自動的に行われる
  }

  /** @returns {boolean} バッファがロード済みか */
  hasBuffer() {
    return this._buffer !== null;
  }

  /** @returns {number} 現在のアクティブボイス数 */
  get activeVoiceCount() {
    return this._activeVoices.size;
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  サンプル再生ヘルパー
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * ArrayBuffer (WAV 等のバイナリ) を AudioBuffer にデコードする。
 * AudioContext が未初期化なら自動で initAudio() を呼ぶ。
 *
 * @param {ArrayBuffer} arrayBuffer  音声バイナリデータ
 * @returns {Promise<AudioBuffer>}
 * @throws {Error}  デコード失敗時
 *
 * @example
 * const wavData = await fetch("click.wav").then(r => r.arrayBuffer());
 * const audioBuf = await decodeAudioBuffer(wavData);
 * const player = new SamplePlayer(audioBuf);
 */
export async function decodeAudioBuffer(arrayBuffer) {
  if (!ctx) initAudio();
  // decodeAudioData は渡された ArrayBuffer を detach するため、コピーを渡す
  const copy = arrayBuffer.slice(0);
  return ctx.decodeAudioData(copy);
}

/**
 * SamplePlayer でワンショット再生する。null 安全。
 * playSfx の Sample 版ヘルパー。
 *
 * @param {SamplePlayer|null|undefined} player
 * @param {number} [playbackRate=1.0]  再生速度
 */
export function playSample(player, playbackRate) {
  if (!player) return;
  player.play(playbackRate);
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  マスターゲイン・ストリーム取得
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * マスターゲインノードを取得する (メトロノーム等が直接接続する用途)。
 * @returns {GainNode|null}
 */
export function getMasterGain() {
  return masterGain;
}

/**
 * 録画用の音声 MediaStream を返す。
 * initAudio() 後に有効。未初期化時は null。
 * @returns {MediaStream|null}
 */
export function getAudioStream() {
  return mediaDest ? mediaDest.stream : null;
}

