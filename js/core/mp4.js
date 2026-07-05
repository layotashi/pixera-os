/**
 * @module core/mp4
 * mp4.js — 1bit フレーム列 (+任意の PCM 音声) を H.264(+AAC)/MP4 として書き出す。
 *
 * ブラウザの WebCodecs `VideoEncoder` で各フレームを H.264 に、`AudioEncoder` で
 * PCM を AAC にエンコードし、その出力を、この場で組み立てる最小限の MP4 コンテナ
 * (ISO BMFF) に詰める。GIF を自前エンコーダ (gif.js) で書いているのと同じ思想で、
 * コンテナ部分は外部依存なしに自作する (エンコーダだけはブラウザ API を借りる)。
 *
 * 注意:
 *   - WebCodecs 非対応ブラウザでは使えない (isMp4Supported() で判定)。
 *   - AAC エンコードはプラットフォーム依存 (isMp4AudioSupported() で判定)。
 *     非対応環境では音声を落として映像のみで書き出す (書き出し自体は失敗させない)。
 *   - H.264 は非可逆。1bit のシャープなディザは高ビットレートでも僅かに滲む。
 *     画質忠実が要るなら GIF/PNG が向く。MP4 の利点は滑らか・長尺・SNS ネイティブ。
 *
 * 構成 (ビデオトラック + 任意のオーディオトラック):
 *   ftyp / moov(mvhd, trak(video), [trak(audio)]) / mdat(映像チャンク + 音声チャンク)
 */

/** WebCodecs による H.264/MP4 書き出しが使えるか */
export function isMp4Supported() {
  return (
    typeof window !== "undefined" &&
    typeof window.VideoEncoder === "function" &&
    typeof window.VideoFrame === "function"
  );
}

// AAC-LC モノラルの希望ビットレート (高い順)。プラットフォームの OS エンコーダが対応
// する最高値を選ぶ (pickAacBitrate)。Windows(Media Foundation) は 192k が上限で 224k↑は
// 非対応、macOS 等はより高い値も通る。モノラルなので 192k でも実質トランスペアレント
// (ステレオ ~384k 相当)。AAC は VBR なので単純な音は自動で節約し、上限は「使える上限」。
const AAC_BITRATES = [320_000, 256_000, 192_000, 160_000, 128_000, 96_000];

/** AAC 音声設定 (モノラル固定)。bitrate は pickAacBitrate が選んだ値。 */
function aacConfig(sampleRate, bitrate) {
  return {
    codec: "mp4a.40.2", // AAC-LC (SNS/プレイヤー互換の標準)
    sampleRate,
    numberOfChannels: 1,
    bitrate,
    aac: { format: "aac" }, // 生のアクセスユニット (ADTS なし) → MP4 に直接詰める
  };
}

/**
 * この環境が対応する AAC-LC mono の最高ビットレートを返す (非対応なら null)。
 * OS エンコーダの上限はプラットフォーム依存なので、高い順に問い合わせて最初に通る値を採る。
 */
export async function pickAacBitrate(sampleRate = 44100) {
  if (typeof window === "undefined" || typeof window.AudioEncoder !== "function")
    return null;
  for (const bitrate of AAC_BITRATES) {
    try {
      const s = await AudioEncoder.isConfigSupported(aacConfig(sampleRate, bitrate));
      if (s && s.supported) return bitrate;
    } catch {
      /* 次の候補へ */
    }
  }
  return null;
}

/** WebCodecs による AAC 音声エンコードが使えるか (プラットフォーム依存) */
export async function isMp4AudioSupported(sampleRate = 44100) {
  return (await pickAacBitrate(sampleRate)) !== null;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  バイト列ヘルパ (ビッグエンディアン)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function u16(n) {
  const a = new Uint8Array(2);
  new DataView(a.buffer).setUint16(0, n);
  return a;
}
function s16(n) {
  const a = new Uint8Array(2);
  new DataView(a.buffer).setInt16(0, n);
  return a;
}
function u32(n) {
  const a = new Uint8Array(4);
  new DataView(a.buffer).setUint32(0, n >>> 0);
  return a;
}
function str4(s) {
  return new Uint8Array([
    s.charCodeAt(0),
    s.charCodeAt(1),
    s.charCodeAt(2),
    s.charCodeAt(3),
  ]);
}
function concat(arrs) {
  let len = 0;
  for (const a of arrs) len += a.length;
  const out = new Uint8Array(len);
  let o = 0;
  for (const a of arrs) {
    out.set(a, o);
    o += a.length;
  }
  return out;
}
/** [size][type][payload...] のボックスを作る */
function box(type, ...chunks) {
  const body = concat(chunks);
  return concat([u32(body.length + 8), str4(type), body]);
}
/** version + flags を先頭に持つ FullBox */
function fullbox(type, version, flags, ...chunks) {
  const vf = new Uint8Array([
    version & 0xff,
    (flags >> 16) & 0xff,
    (flags >> 8) & 0xff,
    flags & 0xff,
  ]);
  return box(type, vf, ...chunks);
}

/* prettier-ignore */
const UNITY_MATRIX = concat([
  u32(0x00010000), u32(0), u32(0),
  u32(0), u32(0x00010000), u32(0),
  u32(0), u32(0), u32(0x40000000),
]);

function toU8(d) {
  if (d instanceof Uint8Array) return d.slice();
  if (d instanceof ArrayBuffer) return new Uint8Array(d.slice(0));
  return new Uint8Array(d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength));
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  MP4 muxer
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** dinf (dref > url) — 全トラック共通の「データは同ファイル内」宣言 */
function buildDinf() {
  return box("dinf", fullbox("dref", 0, 0, u32(1), fullbox("url ", 0, 1)));
}

/** hdlr — handler_type と名前 */
function buildHdlr(type, name) {
  return fullbox(
    "hdlr", 0, 0,
    u32(0), str4(type), u32(0), u32(0), u32(0),
    new Uint8Array([...new TextEncoder().encode(name), 0]),
  );
}

/**
 * ビデオトラック (trak) を構築する。
 * @param {number} movieDur  ムービータイムスケール (ms) での長さ
 * @param {number} stcoOffset  映像チャンクのファイル先頭からのオフセット
 */
function buildVideoTrak(sizes, keyframes, avcC, w, h, fps, movieDur, stcoOffset) {
  const n = sizes.length;

  const tkhd = fullbox(
    "tkhd", 0, 7, // enabled | in movie | in preview
    u32(0), u32(0), u32(1), u32(0), u32(movieDur),
    u32(0), u32(0), // reserved
    s16(0), s16(0), s16(0), u16(0), // layer, alt_group, volume, reserved
    UNITY_MATRIX,
    u32(w << 16), u32(h << 16), // 16.16 fixed
  );

  // メディアタイムスケール = fps、1 フレーム = 1 単位
  const mdhd = fullbox(
    "mdhd", 0, 0,
    u32(0), u32(0), u32(fps), u32(n),
    u16(0x55c4), // language 'und'
    u16(0),
  );

  const vmhd = fullbox("vmhd", 0, 1, u16(0), u16(0), u16(0), u16(0));

  // stsd > avc1 > avcC
  const avcCbox = box("avcC", avcC);
  const avc1 = box(
    "avc1",
    new Uint8Array(6), u16(1), // reserved + data_reference_index
    new Uint8Array(16), // pre_defined / reserved
    u16(w), u16(h),
    u32(0x00480000), u32(0x00480000), // 72dpi
    u32(0), u16(1), // reserved, frame_count
    new Uint8Array(32), // compressorname
    u16(0x0018), s16(-1), // depth, pre_defined
    avcCbox,
  );
  const stsd = fullbox("stsd", 0, 0, u32(1), avc1);
  const stts = fullbox("stts", 0, 0, u32(1), u32(n), u32(1));
  const stsc = fullbox("stsc", 0, 0, u32(1), u32(1), u32(n), u32(1));
  const stsz = fullbox("stsz", 0, 0, u32(0), u32(n), concat(sizes.map(u32)));
  const stco = fullbox("stco", 0, 0, u32(1), u32(stcoOffset));
  const stss = fullbox(
    "stss", 0, 0, u32(keyframes.length), concat(keyframes.map((k) => u32(k))),
  );

  const stbl = box("stbl", stsd, stts, stsc, stsz, stco, stss);
  const minf = box("minf", vmhd, buildDinf(), stbl);
  const mdia = box("mdia", mdhd, buildHdlr("vide", "PIXERA"), minf);
  return box("trak", tkhd, mdia);
}

/** AAC のサンプリング周波数インデックス (AudioSpecificConfig 用) */
const AAC_FREQS = [
  96000, 88200, 64000, 48000, 44100, 32000,
  24000, 22050, 16000, 12000, 11025, 8000, 7350,
];

/** AAC-LC モノラルの AudioSpecificConfig (2 byte) を組み立てる (description 欠落時の保険) */
function defaultAsc(sampleRate) {
  const idx = Math.max(0, AAC_FREQS.indexOf(sampleRate));
  // objectType(5)=2(AAC-LC) | freqIdx(4) | chanCfg(4)=1 | GASpecificConfig(3)=0
  return new Uint8Array([(2 << 3) | (idx >> 1), ((idx & 1) << 7) | (1 << 3)]);
}

/** MPEG-4 記述子 [tag][length][body] (サイズは全て <128 の前提で 1 byte 長) */
function descriptor(tag, body) {
  return concat([new Uint8Array([tag, body.length]), body]);
}

/** esds — AAC の DecoderSpecificInfo (AudioSpecificConfig) を運ぶ記述子ボックス */
function buildEsds(asc, bitrate) {
  const dsi = descriptor(0x05, asc); // DecoderSpecificInfo
  const dcd = descriptor(
    0x04, // DecoderConfigDescriptor
    concat([
      new Uint8Array([0x40, 0x15]), // objectType=AAC, streamType=audio
      new Uint8Array([0, 0, 0]), // bufferSizeDB (u24)
      u32(bitrate), u32(bitrate), // max/avg bitrate
      dsi,
    ]),
  );
  const slc = descriptor(0x06, new Uint8Array([0x02])); // SLConfig (MP4 予約値)
  const es = descriptor(0x03, concat([u16(1), new Uint8Array([0]), dcd, slc]));
  return fullbox("esds", 0, 0, es);
}

/**
 * オーディオトラック (trak) を構築する。AAC は 1 アクセスユニット = 1024 PCM サンプル。
 * @param {{chunks:Uint8Array[], asc:Uint8Array, sampleRate:number}} audio
 */
function buildAudioTrak(audio, movieDur, stcoOffset) {
  const n = audio.chunks.length;
  const sr = audio.sampleRate;

  const tkhd = fullbox(
    "tkhd", 0, 7,
    u32(0), u32(0), u32(2), u32(0), u32(movieDur), // track_ID = 2
    u32(0), u32(0),
    s16(0), s16(0), s16(0x0100), u16(0), // volume 1.0 (音声トラック)
    UNITY_MATRIX,
    u32(0), u32(0), // width/height = 0
  );

  // メディアタイムスケール = sampleRate、長さ = AAC フレーム数 × 1024
  const mdhd = fullbox(
    "mdhd", 0, 0,
    u32(0), u32(0), u32(sr), u32(n * 1024),
    u16(0x55c4),
    u16(0),
  );

  const smhd = fullbox("smhd", 0, 0, u16(0), u16(0));

  // stsd > mp4a > esds
  const mp4a = box(
    "mp4a",
    new Uint8Array(6), u16(1), // reserved + data_reference_index
    u32(0), u32(0), // reserved
    u16(1), u16(16), // channelcount (mono), samplesize
    u16(0), u16(0), // pre_defined, reserved
    u32(sr << 16), // samplerate 16.16
    buildEsds(audio.asc, audio.bitrate || 128_000), // esds の bitrate は実際の選択値
  );
  const stsd = fullbox("stsd", 0, 0, u32(1), mp4a);
  const stts = fullbox("stts", 0, 0, u32(1), u32(n), u32(1024));
  const stsc = fullbox("stsc", 0, 0, u32(1), u32(1), u32(n), u32(1));
  const stsz = fullbox(
    "stsz", 0, 0, u32(0), u32(n),
    concat(audio.chunks.map((c) => u32(c.length))),
  );
  const stco = fullbox("stco", 0, 0, u32(1), u32(stcoOffset));

  const stbl = box("stbl", stsd, stts, stsc, stsz, stco); // 音声は全サンプルが sync (stss 不要)
  const minf = box("minf", smhd, buildDinf(), stbl);
  const mdia = box("mdia", mdhd, buildHdlr("soun", "PIXERA"), minf);
  return box("trak", tkhd, mdia);
}

/**
 * moov ボックスを構築する。stco の chunk offset は引数で受け取る。
 * (offset は固定長フィールドなので、値が変わっても moov の長さは不変。
 *  → 一度仮の値で長さを測り、本当の mdat オフセットで作り直せる)
 */
function buildMoov(video, audio, movieDur, videoOffset, audioOffset) {
  const mvhd = fullbox(
    "mvhd", 0, 0,
    u32(0), u32(0), u32(1000), u32(movieDur), // ムービータイムスケール = 1000 (ms)
    u32(0x00010000), // rate 1.0
    u16(0x0100), // volume 1.0
    u16(0), u32(0), u32(0), // reserved
    UNITY_MATRIX,
    u32(0), u32(0), u32(0), u32(0), u32(0), u32(0), // pre_defined
    u32(audio ? 3 : 2), // next_track_ID
  );
  const traks = [
    buildVideoTrak(
      video.sizes, video.keyframes, video.avcC,
      video.w, video.h, video.fps, movieDur, videoOffset,
    ),
  ];
  if (audio) traks.push(buildAudioTrak(audio, movieDur, audioOffset));
  return box("moov", mvhd, ...traks);
}

/**
 * エンコード済みサンプル列を MP4 Blob にまとめる (純関数 — 単体テスト対象)。
 * mdat は「映像チャンク → 音声チャンク」の 2 チャンク構成。
 * @param {{data:Uint8Array, key:boolean}[]} samples  H.264 アクセスユニット列
 * @param {{chunks:Uint8Array[], asc:Uint8Array, sampleRate:number}|null} [audio]
 */
export function muxMp4(samples, avcC, w, h, fps, audio = null) {
  const sizes = samples.map((s) => s.data.length);
  const keyframes = [];
  samples.forEach((s, i) => {
    if (s.key) keyframes.push(i + 1); // stss は 1 始まり
  });
  if (keyframes.length === 0) keyframes.push(1);
  const video = { sizes, keyframes, avcC, w, h, fps };
  const movieDur = Math.round((samples.length / fps) * 1000); // ms

  const ftyp = box(
    "ftyp",
    str4("isom"), u32(0x200),
    str4("isom"), str4("iso2"), str4("avc1"), str4("mp41"),
  );

  const videoBytes = sizes.reduce((a, b) => a + b, 0);

  // 1 回目: 仮オフセットで moov 長を確定 → mdat データ開始位置を算出
  let moov = buildMoov(video, audio, movieDur, 0, 0);
  const videoOffset = ftyp.length + moov.length + 8;
  const audioOffset = videoOffset + videoBytes;
  // 2 回目: 本当の chunk offset で作り直す (長さは不変)
  moov = buildMoov(video, audio, movieDur, videoOffset, audioOffset);

  const parts = samples.map((s) => s.data);
  if (audio) parts.push(...audio.chunks);
  const mdatBody = concat(parts);
  const mdat = concat([u32(mdatBody.length + 8), str4("mdat"), mdatBody]);

  return new Blob([ftyp, moov, mdat], { type: "video/mp4" });
}

/**
 * PCM (Float32 モノラル) を WebCodecs で AAC にエンコードする。
 * @returns {Promise<{chunks:Uint8Array[], asc:Uint8Array, sampleRate:number}|null>}
 *   非対応/失敗時は null (呼び側は音声なしで続行する)
 */
async function encodeAacMono(pcm, sampleRate) {
  const bitrate = await pickAacBitrate(sampleRate);
  if (bitrate == null) return null;
  const chunks = [];
  let asc = null;
  let encErr = null;
  const encoder = new AudioEncoder({
    output: (chunk, meta) => {
      const desc = meta && meta.decoderConfig && meta.decoderConfig.description;
      if (desc && !asc) asc = toU8(desc);
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      chunks.push(data);
    },
    error: (e) => {
      encErr = e;
    },
  });
  encoder.configure(aacConfig(sampleRate, bitrate));

  // 1 秒ずつ AudioData として投入 (エンコーダが 1024 サンプル単位の AU に切る)
  for (let off = 0; off < pcm.length && !encErr; off += sampleRate) {
    const part = pcm.subarray(off, Math.min(off + sampleRate, pcm.length));
    const ad = new AudioData({
      format: "f32",
      sampleRate,
      numberOfFrames: part.length,
      numberOfChannels: 1,
      timestamp: Math.round((off / sampleRate) * 1_000_000),
      data: part,
    });
    encoder.encode(ad);
    ad.close();
  }
  await encoder.flush();
  encoder.close();

  if (encErr || chunks.length === 0) return null;
  return { chunks, asc: asc || defaultAsc(sampleRate), sampleRate, bitrate };
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  エンコード
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** 解像度に応じて対応する H.264 コーデック文字列を選ぶ (互換性の高い順に試す) */
async function pickCodec(w, h, fps, bitrate) {
  // baseline L3.1 → L4.0 → L5.1 → main/high L5.1。
  // 小さい絵は baseline 低レベル (最も再生互換が高い)、大きい絵は上のレベルへ。
  const candidates = [
    "avc1.42E01F",
    "avc1.42E028",
    "avc1.42E033",
    "avc1.4D4033",
    "avc1.640033",
  ];
  for (const codec of candidates) {
    try {
      const support = await VideoEncoder.isConfigSupported({
        codec,
        width: w,
        height: h,
        bitrate,
        framerate: fps,
        avc: { format: "avc" },
      });
      if (support && support.supported) return codec;
    } catch (_) {
      /* 次の候補へ */
    }
  }
  return null;
}

/**
 * 1bit フレーム列 (+任意の PCM 音声) を H.264(+AAC)/MP4 にエンコードする。
 *
 * @param {Uint8Array[]} frames  各要素が 0/1 の画素 (length = w*h)
 * @param {number} w  フレーム幅 (画素)
 * @param {number} h  フレーム高さ (画素)
 * @param {number[]} bgRgb  背景色 [r,g,b]
 * @param {number[]} fgRgb  前景色 [r,g,b]
 * @param {number} fps  フレームレート
 * @param {number} scale  拡大率 (出力解像度 = w*scale × h*scale、偶数に丸め)
 * @param {{samples:Float32Array, sampleRate:number}|null} [audio]  PCM 音声 (モノラル)。
 *   AAC 非対応環境やエンコード失敗時は音声を落とし映像のみで書き出す。
 * @returns {Promise<Blob>}  MP4 Blob
 */
export async function encodeMp4(frames, w, h, bgRgb, fgRgb, fps, scale, audio = null) {
  if (!isMp4Supported()) throw new Error("WebCodecs unavailable");
  if (!frames || frames.length === 0) throw new Error("no frames");

  // H.264 は偶数寸法が前提
  let outW = Math.max(2, Math.round(w * scale));
  let outH = Math.max(2, Math.round(h * scale));
  if (outW & 1) outW++;
  if (outH & 1) outH++;

  const bitrate = Math.min(
    60_000_000,
    Math.max(4_000_000, Math.round(outW * outH * fps * 0.3)),
  );
  const codec = await pickCodec(outW, outH, fps, bitrate);
  if (!codec) throw new Error("H.264 encode unsupported for this size");

  // 1bit → RGBA → 拡大描画用のキャンバス
  const src = document.createElement("canvas");
  src.width = w;
  src.height = h;
  const sctx = src.getContext("2d");
  const img = sctx.createImageData(w, h);
  const out = document.createElement("canvas");
  out.width = outW;
  out.height = outH;
  const octx = out.getContext("2d");
  octx.imageSmoothingEnabled = false; // ニアレストネイバー (1bit のドットを保つ)

  const samples = [];
  let description = null;
  let encErr = null;
  const encoder = new VideoEncoder({
    output: (chunk, meta) => {
      const desc = meta && meta.decoderConfig && meta.decoderConfig.description;
      if (desc && !description) description = toU8(desc);
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      samples.push({ data, key: chunk.type === "key" });
    },
    error: (e) => {
      encErr = e;
    },
  });
  encoder.configure({
    codec,
    width: outW,
    height: outH,
    bitrate,
    framerate: fps,
    avc: { format: "avc" }, // AVCC (length-prefixed) で出力 → MP4 に直接詰められる
  });

  const frameDur = Math.round(1_000_000 / fps); // マイクロ秒
  for (let i = 0; i < frames.length; i++) {
    if (encErr) break;
    const f = frames[i];
    const d = img.data;
    for (let p = 0, j = 0; p < f.length; p++, j += 4) {
      if (f[p]) {
        d[j] = fgRgb[0];
        d[j + 1] = fgRgb[1];
        d[j + 2] = fgRgb[2];
      } else {
        d[j] = bgRgb[0];
        d[j + 1] = bgRgb[1];
        d[j + 2] = bgRgb[2];
      }
      d[j + 3] = 255;
    }
    sctx.putImageData(img, 0, 0);
    octx.drawImage(src, 0, 0, w, h, 0, 0, outW, outH);
    const vf = new VideoFrame(out, { timestamp: i * frameDur, duration: frameDur });
    // 1 秒ごとにキーフレーム (短いループでもシーク/ループ復帰が安定)
    encoder.encode(vf, { keyFrame: i % fps === 0 });
    vf.close();
  }

  await encoder.flush();
  encoder.close();

  if (encErr) throw encErr;
  if (samples.length === 0) throw new Error("encoder produced no samples");
  if (!description) throw new Error("missing avcC description");

  // 音声 (任意): AAC 化に失敗しても映像は書き出す (ライブ用途で export を殺さない)
  let aac = null;
  if (audio && audio.samples && audio.samples.length > 0) {
    try {
      aac = await encodeAacMono(audio.samples, audio.sampleRate);
    } catch (e) {
      console.warn("[mp4] AAC encode failed, exporting video only:", e);
    }
  }

  return muxMp4(samples, description, outW, outH, fps, aac);
}
