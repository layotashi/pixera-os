/**
 * chip_worklet.js — チップ音源 (波形メモリ) の AudioWorkletProcessor。
 *
 * オーディオレンダリングスレッドで動く発音エンジン。メインスレッド (chip.js) から
 * 波形メモリ・音色・発音イベントを受け取り、ボイスプールでサンプル毎に合成する。
 * オーディオスレッドで動くため、メインスレッドの描画ジャンク (TESSERA 背景等) や GC に
 * 一切影響されない ＝「音声最優先・描画は残りで」を最強の形で満たす。
 *
 * このファイルは AudioWorkletGlobalScope で評価される。ES モジュール import は使えず、
 * currentTime / currentFrame / sampleRate / registerProcessor はグローバルとして与えられる。
 * chip.js から `ctx.audioWorklet.addModule()` で読み込む。
 *
 * ── チャンネル (音源) ──
 *   複数の音源 (SYNTH・ROLL 内蔵フォールバック・将来のマルチトラック) が 1 つのワークレットを
 *   共有できるよう、音色パラメータは channel 単位で持つ。ボイスは全チャンネル共通のプールから
 *   割り当て、発音数上限はチャンネル単位で守る。tracks レジストリ (音楽アプリ連携) の土台。
 *
 * ── 発火のタイミング ──
 *   process() は 128 サンプル (レンダークォンタム) 単位で呼ばれる。currentFrame はそのクォンタム
 *   先頭の絶対サンプル番号。ライブイベントは {time(秒)} を絶対サンプルに直し、クォンタム内の
 *   サンプル位置で発火する (サブクォンタム精度)。時刻軸はメインの ctx.currentTime と同一。
 *
 * ── DRY 注意 ──
 *   量子化 (16 段音量) など「発音の要となる数式」は js/core/chip_dsp.js を正典とし、ここは
 *   同等ロジックをミラー実装している (ワークレットは import 不可のため)。両者は必ず一致させる。
 *
 * Phase 1: ライブイベント (SYNTH の鍵盤/MIDI・ROLL の試聴) のみ。
 * Phase 2 でパターン + トランスポート時計による自走シーケンサをここに足す。
 *
 * port プロトコル (メイン → ワークレット):
 *   { type:"tables",  tables:{saw:Float32Array,...}, tableSize }
 *   { type:"params",  channel, waveform, a, d, s, r, volume, maxVoices } // a/d/r=秒, s/volume=0..1
 *   { type:"noteOn",  channel, id, midi, vel, time }                     // vel=0..1, time=秒(ctx基準)
 *   { type:"noteOff", channel, id, time }
 *   { type:"allNotesOff", channel? }   // channel 省略時は全チャンネル
 *   // ── シーケンサ (Phase 2) ──
 *   { type:"pattern",   notes:[{midi,startStep,lenSteps,vel}], stepsPerBeat }
 *   { type:"transport", channel, playing, bpm, startBeat, startTime, loopStart, loopEnd, loopOn }
 */

/** 最大同時発音数の既定 (PolySynth の DEFAULT_MAX_VOICES に一致)。 */
const DEFAULT_MAX_VOICES = 16;

/** シーケンサ発音の id オフセット。ライブ発音 (id=midi) と同一チャンネル・同一音高でも
 *  ボイスが衝突しないよう別 id 空間にする (伴奏に合わせて同じ鍵盤を弾いても両立する)。 */
const SEQ_ID_BASE = 100000;

/** ボイスプール総数 (全チャンネル共有)。 */
const VOICE_POOL = 64;

/** 音量の量子化段数 (chip_dsp.VOLUME_STEPS のミラー)。 */
const VOLUME_STEPS = 16;

/** MIDI ノート番号 → 周波数 (audio.midiToFreq のミラー。worklet は import 不可)。 */
function midiToFreq(midi) {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

/** 音量 (0..1) を 16 段階に量子化 (chip_dsp.quantizeVolume16 のミラー)。 */
function quantizeVolume16(v) {
  if (!(v > 0)) return 0;
  if (v >= 1) return 1;
  const maxLevel = VOLUME_STEPS - 1;
  return Math.round(v * maxLevel) / maxLevel;
}

/** エンベロープ段階 */
const STAGE_ATTACK = 0;
const STAGE_DECAY = 1;
const STAGE_SUSTAIN = 2;
const STAGE_RELEASE = 3;
const STAGE_IDLE = 4;

class ChipProcessor extends AudioWorkletProcessor {
  constructor() {
    super();

    /** @type {Object<string, Float32Array>} 波形メモリ (調性波形)。noise は実時間生成 */
    this._tables = {};
    /** @type {number} テーブル長 */
    this._tableSize = 256;

    /** @type {Map<number, object>} channel → 音色パラメータ */
    this._channels = new Map();

    /** ボイスプール (固定長。active=false は空き) */
    this._voices = [];
    for (let i = 0; i < VOICE_POOL; i++) this._voices.push(this._blankVoice());

    /** @type {Array<object>} 発火待ちイベント (atSample 昇順)。ライブ + シーケンサ共通 */
    this._events = [];

    /** ボイス割当順 (最古スティール用の単調増加カウンタ) */
    this._seq = 0;

    // ── 自走シーケンサ (パターン + トランスポート時計から発火) ──
    /** @type {{notes:Array<object>, stepsPerBeat:number}} */
    this._pattern = { notes: [], stepsPerBeat: 4 };
    /** @type {object} トランスポート状態 (メインの transport をミラー) */
    this._transport = {
      playing: false,
      bpm: 120,
      startBeat: 0,
      startTime: 0,
      loopStart: 0,
      loopEnd: 16,
      loopOn: true,
    };
    /** シーケンサの発音先チャンネル */
    this._seqChannel = 0;
    /** 次に発火判定を始める絶対サンプル (連続する窓で重複/取りこぼしを防ぐ) */
    this._seqCursor = 0;
    /** アンカー変化検知用 (再開/シークで再スケジュールするため) */
    this._lastStartTime = 0;
    this._lastStartBeat = 0;

    this.port.onmessage = (e) => this._onMessage(e.data);
  }

  /** channel の音色パラメータを取得 (無ければ既定で生成)。 */
  _channel(id) {
    let c = this._channels.get(id);
    if (!c) {
      c = {
        waveform: "sq50",
        atkSec: 0,
        decSec: 0,
        sustain: 1,
        relSec: 0,
        volume: 0.5,
        maxVoices: DEFAULT_MAX_VOICES,
      };
      this._channels.set(id, c);
    }
    return c;
  }

  _blankVoice() {
    return {
      active: false,
      channel: -1,
      id: -1,
      isNoise: false,
      table: null,
      phase: 0, // 0..1 (1 周期の位相)
      inc: 0, // 位相増分/サンプル
      amp: 0, // 量子化済み振幅 (volume*vel)
      vel: 1,
      env: 0, // 現在エンベロープ値 0..1
      stage: STAGE_IDLE,
      sustain: 1, // 発音時に確定 (チャンネル依存を持ち込まないため voice に焼く)
      atkStep: 1,
      decStep: 1,
      relSec: 0, // noteOff で relStep を出すのに使う
      relStep: 1,
      noiseVal: 0,
      noisePhase: 0,
      order: 0, // 割当順 (スティール判定)
    };
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  //  メッセージ処理
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  _onMessage(msg) {
    switch (msg.type) {
      case "tables":
        this._tables = msg.tables || {};
        this._tableSize = msg.tableSize || 256;
        break;
      case "params": {
        const c = this._channel(msg.channel | 0);
        if (msg.waveform !== undefined) c.waveform = msg.waveform;
        if (msg.a !== undefined) c.atkSec = msg.a;
        if (msg.d !== undefined) c.decSec = msg.d;
        if (msg.s !== undefined) c.sustain = msg.s;
        if (msg.r !== undefined) c.relSec = msg.r;
        if (msg.maxVoices !== undefined) c.maxVoices = Math.max(1, msg.maxVoices | 0);
        if (msg.volume !== undefined) {
          c.volume = msg.volume;
          // VOL 変更を発音中ボイスにも即反映 (PolySynth.setVolume と同じ体感)
          const ch = msg.channel | 0;
          for (const v of this._voices) {
            if (v.active && v.channel === ch) v.amp = quantizeVolume16(c.volume * v.vel);
          }
        }
        break;
      }
      case "noteOn":
        this._enqueue(this._timeToSample(msg.time), {
          kind: "on",
          channel: msg.channel | 0,
          id: msg.id,
          midi: msg.midi,
          vel: msg.vel != null ? msg.vel : 1,
        });
        break;
      case "noteOff":
        this._enqueue(this._timeToSample(msg.time), {
          kind: "off",
          channel: msg.channel | 0,
          id: msg.id,
        });
        break;
      case "allNotesOff": {
        // 予約中イベントも破棄して即時消音。channel 指定でそのチャンネルのみ、
        // liveOnly でライブ発音のみ (id<SEQ_ID_BASE) を対象にする。後者はタブ非表示時の
        // パニック消音用 — 押しっぱなしのライブ音だけ止め、自走シーケンサは乱さない。
        const chanFilter = msg.channel == null ? null : msg.channel | 0;
        const liveOnly = !!msg.liveOnly;
        const keep = (target) =>
          (chanFilter != null && target.channel !== chanFilter) ||
          (liveOnly && target.id >= SEQ_ID_BASE);
        this._events = this._events.filter(keep);
        for (const v of this._voices) if (v.active && !keep(v)) this._deactivate(v);
        break;
      }
      case "pattern":
        // パターン差し替え。発音中ボイスは止めない (予約済み off で自然に消える)。
        // 未来のオンセットは次クォンタムから新パターンで再導出される (編集の即時反映)。
        this._pattern = {
          notes: msg.notes || [],
          stepsPerBeat: msg.stepsPerBeat || 4,
        };
        break;
      case "transport": {
        const tp = this._transport;
        tp.bpm = msg.bpm;
        tp.loopStart = msg.loopStart;
        tp.loopEnd = msg.loopEnd;
        tp.loopOn = msg.loopOn;
        if (msg.channel != null) this._seqChannel = msg.channel | 0;
        const wasPlaying = tp.playing;
        tp.playing = !!msg.playing;
        tp.startBeat = msg.startBeat;
        tp.startTime = msg.startTime;
        // アンカー (開始位置/時刻) が変わった = (再)開始 or シーク。予約を捨ててアンカーから
        // 再スケジュールする。テンポ/ループだけの変更ではカーソルを保ち連続性を維持する。
        const anchorChanged =
          msg.startTime !== this._lastStartTime || msg.startBeat !== this._lastStartBeat;
        this._lastStartTime = msg.startTime;
        this._lastStartBeat = msg.startBeat;
        if (!tp.playing) {
          this._clearSeq(); // 停止: 発音中のシーケンス音を消す
        } else if (anchorChanged || !wasPlaying) {
          this._clearSeq();
          this._seqCursor = Math.round(tp.startTime * sampleRate);
        }
        break;
      }
    }
  }

  /** シーケンサ由来の予約イベント・発音中ボイスだけを消す (ライブ発音は残す)。 */
  _clearSeq() {
    this._events = this._events.filter((e) => e.id < SEQ_ID_BASE);
    for (const v of this._voices) {
      if (v.active && v.id >= SEQ_ID_BASE) this._deactivate(v);
    }
  }

  /** 秒 (ctx.currentTime 基準) → 絶対サンプル番号。過去はクォンタム先頭にクランプ。 */
  _timeToSample(time) {
    if (time == null) return currentFrame; // 「今すぐ」
    return Math.max(currentFrame, Math.round(time * sampleRate));
  }

  /** イベントを atSample 昇順に挿入する。 */
  _enqueue(atSample, ev) {
    ev.atSample = atSample;
    const arr = this._events;
    let i = arr.length;
    while (i > 0 && arr[i - 1].atSample > atSample) i--;
    arr.splice(i, 0, ev);
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  //  ボイス割当 / 解放
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  /** channel 用に空きボイスを取得。上限超過/枯渇時はスティール。 */
  _allocVoice(channel, maxVoices) {
    let free = null;
    let chActive = 0;
    for (const v of this._voices) {
      if (!v.active) {
        if (!free) free = v;
      } else if (v.channel === channel) {
        chActive++;
      }
    }
    // チャンネルの発音数上限 → 同チャンネルからスティール
    if (chActive >= maxVoices) {
      const victim = this._stealVictim(channel);
      if (victim) {
        this._deactivate(victim);
        return victim;
      }
    }
    if (free) return free;
    // プール枯渇 → 全体最古を奪う
    const victim = this._stealVictim(null);
    if (victim) {
      this._deactivate(victim);
      return victim;
    }
    return this._voices[0];
  }

  /** スティール対象を選ぶ。リリース中優先、次に最古。channel 指定時はそのチャンネル内。 */
  _stealVictim(channel) {
    let victim = null;
    // リリース中を優先
    for (const v of this._voices) {
      if (!v.active) continue;
      if (channel != null && v.channel !== channel) continue;
      if (v.stage === STAGE_RELEASE && (!victim || v.order < victim.order)) victim = v;
    }
    if (victim) return victim;
    // 最古の押鍵
    for (const v of this._voices) {
      if (!v.active) continue;
      if (channel != null && v.channel !== channel) continue;
      if (!victim || v.order < victim.order) victim = v;
    }
    return victim;
  }

  _deactivate(v) {
    v.active = false;
    v.stage = STAGE_IDLE;
    v.env = 0;
    v.id = -1;
    v.channel = -1;
  }

  _noteOn(channel, id, midi, vel) {
    const c = this._channel(channel);
    // retrigger: 同 channel/id の発音中ボイスを止めてから鳴らす
    for (const v of this._voices) {
      if (v.active && v.channel === channel && v.id === id && v.stage !== STAGE_RELEASE) {
        this._deactivate(v);
      }
    }
    const v = this._allocVoice(channel, c.maxVoices);
    const isNoise = c.waveform === "noise";
    v.active = true;
    v.channel = channel;
    v.id = id;
    v.isNoise = isNoise;
    v.table = isNoise ? null : this._tables[c.waveform] || null;
    v.inc = midiToFreq(midi) / sampleRate;
    v.phase = 0;
    v.noisePhase = 0;
    v.noiseVal = Math.random() * 2 - 1;
    v.vel = vel;
    v.amp = quantizeVolume16(c.volume * vel);
    v.order = this._seq++;

    // エンベロープを voice に焼く (以降チャンネル依存を持ち込まない)。
    // 時間 0 は即時 = チップのハードなクリック (意図された音色特性)。
    v.sustain = c.sustain;
    v.relSec = c.relSec;
    v.atkStep = c.atkSec > 0 ? 1 / (c.atkSec * sampleRate) : 1;
    v.decStep = c.decSec > 0 ? (1 - c.sustain) / (c.decSec * sampleRate) : 1 - c.sustain;
    v.env = 0;
    v.stage = STAGE_ATTACK;
  }

  _noteOff(channel, id) {
    for (const v of this._voices) {
      if (v.active && v.channel === channel && v.id === id && v.stage !== STAGE_RELEASE) {
        v.relStep = v.relSec > 0 ? v.env / (v.relSec * sampleRate) : v.env;
        if (!(v.relStep > 0)) v.relStep = v.env || 1; // 保険 (即カット)
        v.stage = STAGE_RELEASE;
      }
    }
  }

  _applyEvent(ev) {
    if (ev.kind === "on") this._noteOn(ev.channel, ev.id, ev.midi, ev.vel);
    else if (ev.kind === "off") this._noteOff(ev.channel, ev.id);
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  //  自走シーケンサ (chip_dsp.notesOnsetsInWindow のミラー)
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  /**
   * このクォンタムがカバーするサンプル窓 [_seqCursor, currentFrame+N) に発火するノートの
   * on/off イベントを予約する。窓は連続 (前クォンタムの終端 = 今回の始端) なので各オンセットは
   * ちょうど 1 度だけ拾う。ループ境界 (末尾→先頭) も周回 k を数えて跨いで発火できる。
   * off はオンセット検出時に一緒に予約するので、パターン編集/ノート削除でも鳴りっぱなしにならない。
   * @param {number} N レンダークォンタムのサンプル数
   */
  _scheduleSeq(N) {
    const t = this._transport;
    if (!t.playing) return;
    const beatsPerSec = t.bpm / 60;
    if (!(beatsPerSec > 0)) return;
    const notes = this._pattern.notes;
    if (!notes.length) {
      this._seqCursor = currentFrame + N;
      return;
    }
    const qEnd = currentFrame + N;
    const t0 = this._seqCursor / sampleRate;
    const t1 = qEnd / sampleRate;
    if (!(t1 > t0)) {
      this._seqCursor = qEnd;
      return;
    }
    const spb = this._pattern.stepsPerBeat || 4;
    const bLin0 = t.startBeat + (t0 - t.startTime) * beatsPerSec;
    const bLin1 = t.startBeat + (t1 - t.startTime) * beatsPerSec;
    const period = t.loopEnd - t.loopStart;
    const looping = t.loopOn && period > 0;
    const ch = this._seqChannel;
    const beatToSample = (b) =>
      Math.round((t.startTime + (b - t.startBeat) / beatsPerSec) * sampleRate);

    for (let i = 0; i < notes.length; i++) {
      const n = notes[i];
      const onBeat = n.startStep / spb;
      const lenBeat = n.lenSteps / spb;
      const id = SEQ_ID_BASE + n.midi;
      if (looping) {
        if (onBeat < t.loopStart || onBeat >= t.loopEnd) continue;
        const offRel = Math.min(lenBeat, t.loopEnd - onBeat); // off はループ末尾で切る
        let cand = onBeat + Math.ceil((bLin0 - onBeat) / period) * period;
        for (; cand < bLin1; cand += period) {
          if (cand < bLin0) continue;
          this._enqueue(beatToSample(cand), {
            kind: "on",
            channel: ch,
            id,
            midi: n.midi,
            vel: n.vel,
          });
          this._enqueue(beatToSample(cand + offRel), { kind: "off", channel: ch, id });
        }
      } else if (onBeat >= bLin0 && onBeat < bLin1) {
        this._enqueue(beatToSample(onBeat), {
          kind: "on",
          channel: ch,
          id,
          midi: n.midi,
          vel: n.vel,
        });
        this._enqueue(beatToSample(onBeat + lenBeat), { kind: "off", channel: ch, id });
      }
    }
    this._seqCursor = qEnd;
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  //  合成
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  /** ボイス v の 1 サンプルを合成し、エンベロープを 1 ステップ進める。 */
  _renderVoiceSample(v) {
    // ── 波形サンプル ──
    let s;
    if (v.isNoise) {
      // ピッチ付きサンプル&ホールド (freq が高いほど白色に近づく)
      v.noisePhase += v.inc;
      if (v.noisePhase >= 1) {
        v.noisePhase -= 1;
        v.noiseVal = Math.random() * 2 - 1;
      }
      s = v.noiseVal;
    } else if (v.table) {
      const size = v.table.length;
      const fp = v.phase * size;
      const i0 = fp | 0;
      const frac = fp - i0;
      const a = v.table[i0];
      const b = v.table[i0 + 1 < size ? i0 + 1 : 0];
      s = a + (b - a) * frac; // 線形補間
      v.phase += v.inc;
      if (v.phase >= 1) v.phase -= v.phase | 0;
    } else {
      s = 0;
      v.phase += v.inc;
      if (v.phase >= 1) v.phase -= v.phase | 0;
    }

    // ── エンベロープ (線形セグメント) ──
    switch (v.stage) {
      case STAGE_ATTACK:
        v.env += v.atkStep;
        if (v.env >= 1) {
          v.env = 1;
          v.stage = v.sustain < 1 ? STAGE_DECAY : STAGE_SUSTAIN;
        }
        break;
      case STAGE_DECAY:
        v.env -= v.decStep;
        if (v.env <= v.sustain) {
          v.env = v.sustain;
          v.stage = STAGE_SUSTAIN;
          if (v.env <= 0) this._deactivate(v);
        }
        break;
      case STAGE_SUSTAIN:
        v.env = v.sustain;
        break;
      case STAGE_RELEASE:
        v.env -= v.relStep;
        if (v.env <= 0) {
          v.env = 0;
          this._deactivate(v);
        }
        break;
    }

    return s * v.env * v.amp;
  }

  process(_inputs, outputs) {
    const output = outputs[0];
    if (!output || output.length === 0) return true;
    const out0 = output[0];
    const N = out0.length;
    const q0 = currentFrame;

    // このクォンタムに発火するシーケンサ発音を予約 (サンプル精度)。
    this._scheduleSeq(N);

    const events = this._events;
    const voices = this._voices;
    const nv = voices.length;
    let ei = 0;

    for (let i = 0; i < N; i++) {
      const absSample = q0 + i;
      // このサンプルで発火するイベントを適用 (過去分は i=0 でまとめて発火)
      while (ei < events.length && events[ei].atSample <= absSample) {
        this._applyEvent(events[ei]);
        ei++;
      }
      // 全ボイスを合成して加算 (オーディオスレッドのホットループ ─ 添字ループで回す)
      let mix = 0;
      for (let vi = 0; vi < nv; vi++) {
        const v = voices[vi];
        if (v.active) mix += this._renderVoiceSample(v);
      }
      out0[i] = mix;
    }
    // 適用済みイベントを捨てる
    if (ei > 0) events.splice(0, ei);

    // 出力チャンネルが複数あれば同じ信号を複製 (モノ音源)
    for (let ch = 1; ch < output.length; ch++) output[ch].set(out0);

    return true;
  }
}

registerProcessor("chip-synth", ChipProcessor);
