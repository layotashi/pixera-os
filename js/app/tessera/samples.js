/**
 * @module app/tessera/samples
 * samples.js — TESSERA 同梱サンプル (.tess) と VFS 種まき
 *
 * 起動時 / 新規の既定コード (DEFAULT_CODE) と、Learn / Gallery / Sound の
 * 作例データ、初回起動で VFS へ書き出す seedSamples() を持つ。純データ + 種まき。
 */

import * as VFS from "../../core/vfs.js";

/** .tess ファイル拡張子 (サンプルのファイル名生成と保存/オープンで共有)。 */
export const EXT = ".tess";

export const HOME_DIR = "/Sketches"; // .tess 作品の保存先（内容カテゴリ「スケッチ」）
// 学習用（番号順・1概念ずつ・解説コメント付き）と作例集（ショーケース）の 2 層。
const LEARN_DIR = "/Sketches/Learn";
const GALLERY_DIR = "/Sketches/Gallery";
const SOUND_DIR = "/Sketches/Gallery/Sound"; // 音付き作品（Alt+P で再生する AV ショーケース）

/** 起動時 / 新規の既定スケッチ。設定ディレクティブの雛形を兼ね、書き方を示す。 */
// 既定コードはフォーマッタの正準形（コロン整列・tight `*`・40桁内）で開く＝設定盤の見本。
export const DEFAULT_CODE = `canvas: 1080x1080
pad:    80
fps:    20
period: tau
seed:   0
view:   dither(2)

sin(x*8 - t)*cos(y*8 + t*2)*.5 + .5`;

/**
 * サンプルは 3 層: LEARN（番号順・1 概念ずつ・解説コメント付き＝見て文法を学ぶ）、
 * GALLERY（ショーケース＝高 ceiling の作例）、GALLERY/Sound（sound: を持つ AV 作例＝
 * Alt+P で相乗効果）。LEARN は LEARN_DIR、GALLERY は GALLERY_DIR、音付きは SOUND_DIR へ。
 * コメント・空行は整形で保持されるので、コメントが学習ガイドとして機能する。
 * 座標は x,y ∈ [0,1]、t は経過秒。
 *
 * 【ループ規約】作品は period（既定 tau）で**きっちりループ**させる（GIF/MP4 の継ぎ目なし）。
 * t は必ず周期 tau の整数分の 1 で使う:
 *   - OK: sin(k*t) / cos(k*t)（k は整数）、ノイズ/fbm 領域を cos(t)/sin(t) で公転
 *   - NG: t の線形ドリフト（t*0.1 等）、非整数倍（t*1.3 等）, sin(t*0.5)（半周期）
 */
const LEARN_SAMPLES = [
  {
    file: "01_field" + EXT,
    src: `// a sketch is a field f(x,y) -> 0..1.
// x,y run 0..1 across the canvas.
// here we just return x (a gradient).
x`,
  },
  {
    file: "02_waves" + EXT,
    src: `// math becomes pattern. sin is -1..1,
// so *.5 + .5 maps it to 0..1.
// x*8 = 8 cycles. change the 8.
sin(x*8)*.5 + .5`,
  },
  {
    file: "03_time" + EXT,
    src: `// t is elapsed seconds; use it to
// animate. subtracting t scrolls the
// wave sideways.
sin(x*8 - t)*.5 + .5`,
  },
  {
    file: "04_shapes" + EXT,
    src: `// dist() = distance to a point.
// name the distance d, then shape it:
// smoothstep makes a soft circle edge.
d = dist(x, y, .5, .5)
1 - smoothstep(.24, .26, d)`,
  },
  {
    file: "05_noise" + EXT,
    src: `// fbm = layered (fractal) noise:
// organic, cloud-like. press Ctrl+R
// to reseed and get a new cloud.
fbm(x*4, y*4, 4)`,
  },
  {
    file: "06_view" + EXT,
    src: `// view: how a field becomes 1-bit.
// try dither / hatch / halftone /
// braille / ascii on the same field.
view: halftone(8)
1 - dist(x, y, .5, .5)`,
  },
  {
    file: "07_output" + EXT,
    src: `// all output settings live in code
// (the file IS the recipe). canvas =
// output px; dots are a fixed 8px
// (chunky). fps snaps to a divisor of
// 100 (5/10/20/25/50/100) so GIF frame
// timing is exact. footer shows fps.
canvas: 1080x1080
fps:    20
seed:   0
fbm(x*3, y*3, 5)`,
  },
  {
    file: "08_repeat" + EXT,
    src: `// a value block runs statements, then
// returns the final expression.
// name repeated parts (dx, dy) for
// readability. here: sum N blobs.
view: dither(2)
s = 0
repeat 4 as k {
  cx = .5 + .28*cos(t + k*1.7)
  cy = .5 + .28*sin(t + k*1.7)
  dx = x - cx
  dy = y - cy
  s  = s + .012/(dx*dx + dy*dy + .001)
}
s/(s + 1)`,
  },
  {
    file: "09_sound" + EXT,
    src: `// sound is a field over time
// a(t) -> -1..1, just like the visual
// field is over space. Alt+P plays
// and stops. chiptune only: pulse =
// square wave. step/seq walk a riff;
// decay(beat(8)) fades every step.
// audio loops over 'period' like the
// view does.
sin(x*8 - t)*.5 + .5

sound:
  p = 45 + seq(step(8), 0, 3, 7, 12)
  pulse(hz(p)) * decay(beat(8))`,
  },
  {
    file: "10_voices" + EXT,
    src: `// name your timbres up top with
// 'voice'. f is the pitch you pass.
// play them by name below and mix by
// adding. 3 parts, one loop. Alt+P.
voice lead: pulse(f, .25)
voice bass: tri(f)
voice hat:  nz(1000)

sin(x*8 - t)*.5 + .5

sound:
  s = step(8)
  n = 60 + seq(s, 0, 3, 7, 10)
  m = lead(hz(n)) * decay(beat(8))
  b = bass(hz(36))
  h = hat() * decay(beat(16))
  m*.4 + b*.4 + h*.2`,
  },
  {
    file: "11_react" + EXT,
    src: `// the picture can read the sound.
// amp = the audio level right now.
// beat(n) shares the loop clock, so
// the picture locks to the rhythm.
// a disc pulses with the beat. Alt+P.
voice lead: pulse(f, .25)

d    = dist(x, y, .5, .5)
disc = 1 - smoothstep(.18, .22, d)
disc * (.25 + .75*amp)

sound:
  n = 50 + seq(step(8), 0, 5, 7, 12)
  lead(hz(n)) * decay(beat(8))`,
  },
];

// 作品(GALLERY)は全ディレクティブを冒頭に明示する（調整時に一覧を調べずその場で直せる）。
// お決まり順 = キャンバス(canvas/pad) → 時間(fps/period) → seed → view。値は既定どおり
// なので見た目は不変＝「全ノブが見えて編集できる」状態にするだけ。
const HEADER = `canvas: 1080x1080
pad:    80
fps:    20
period: tau
seed:   0
view:   dither(2)

`;

const GALLERY_SAMPLES = [
  {
    // WAVE: 複数点源の同心波の干渉。seed で点源位置と周波数が変わる
    file: "wave" + EXT,
    src: HEADER + `cx0 = .2 + rnd(1, 0)*.6
cy0 = .2 + rnd(2, 0)*.6
cx1 = .2 + rnd(3, 0)*.6
cy1 = .2 + rnd(4, 0)*.6
f   = 30 + rnd(5, 0)*24
d0  = dist(x, y, cx0, cy0)
d1  = dist(x, y, cx1, cy1)
( sin(d0*f - t*2)
+ sin(d1*f - t*2)
)*.25 + .5`,
  },
  {
    // PLASMA: sin/cos 多重干渉プラズマ。seed で位相・周波数・源が変わる
    file: "plasma" + EXT,
    src: HEADER + `p1 = rnd(1, 0)*TAU
p2 = rnd(2, 0)*TAU
p3 = rnd(3, 0)*TAU
cx = .3 + rnd(4, 0)*.4
cy = .3 + rnd(5, 0)*.4
fa = 6 + rnd(6, 0)*6
w0 = sin(x*fa + t + p1)
w1 = sin(y*fa - t + p2)
w2 = sin((x + y)*6 + t + p3)
w3 = sin(dist(x, y, cx, cy)*12 - t)
(w0 + w1 + w2 + w3)*.125 + .5`,
  },
  {
    // DRIFT: fbm 密度場。標本点が円運動し雲のように漂う
    file: "drift" + EXT,
    src: HEADER + `u = x*4 + sin(t)*.3
v = y*4 + cos(t)*.3
fbm(u, v, 4)`,
  },
  {
    // GRID: 市松テッセレーション（ゆっくり漂う）。seed で格子数とずれが変わる
    file: "grid" + EXT,
    src: HEADER + `n  = 4 + floor(rnd(1, 0)*9)
ox = rnd(2, 0)*4
oy = rnd(3, 0)*4
gx = floor(x*n + ox + sin(t)*2)
gy = floor(y*n + oy + cos(t)*2)
step(.5, mod(gx + gy, 2))`,
  },
  {
    // MOIRE: わずかに角度のずれた 2 枚の同周波グレーティングの積（うなり）。
    // seed で周波数・基準角・ずれ角が変わる
    file: "moire" + EXT,
    src: HEADER + `f  = 14 + rnd(1, 0)*14
a0 = rnd(2, 0)*TAU
da = .1 + rnd(3, 0)*.22
p  = t + a0
q  = t + a0 + da
g0 = sin((x*cos(p) + y*sin(p))*f)
g1 = sin((x*cos(q) + y*sin(q))*f)
g0*g1*.5 + .5`,
  },
  {
    // CAUSTIC: 進行波の和を尾根化し鋭く累乗 → 水面の光の網目。
    // seed で 3 波の周波数と位相が変わる
    file: "caustic" + EXT,
    src: HEADER + `f1 = 16 + rnd(1, 0)*12
f2 = 16 + rnd(2, 0)*12
f3 = 12 + rnd(3, 0)*10
p1 = rnd(4, 0)*TAU
p2 = rnd(5, 0)*TAU
p3 = rnd(6, 0)*TAU
w1 = sin(x*f1 + t*2 + p1)
w2 = sin(y*f2 - t*2 + p2)
w3 = sin((x + y)*f3 + t + p3)
s  = (w1 + w2 + w3)/3
(1 - abs(s))^4`,
  },
  {
    // QUASIC: 等角に並べた N 枚平面波の和 → 準結晶。
    // seed で対称数 N(5..8)・回転・周波数が変わる
    file: "quasic" + EXT,
    src: HEADER + `n  = 5 + floor(rnd(1, 0)*4)
r  = rnd(2, 0)*TAU
f  = 22 + rnd(3, 0)*18
cx = x - .5
cy = y - .5
s  = 0
repeat n as k {
  a = k*(TAU/n) + r
  u = cx*cos(a) + cy*sin(a)
  s = s + cos(u*f + t)
}
s/n*.5 + .5`,
  },
  {
    // JULIA: z <- z*z + c の脱出時間（値ブロックで反復）。c が円運動し形態変化。
    // seed で c の中心と円運動半径が変わる＝別の Julia 集合（樹枝/兎/渦…）が出る
    file: "julia" + EXT,
    src: HEADER + `ccx = -.75 + rnd(1, 0)*.7
ccy = -.3 + rnd(2, 0)*.6
rad = .12 + rnd(3, 0)*.16
zr  = (x - .5)*3
zi  = (y - .5)*3
cr  = cos(t)*rad + ccx
ci  = sin(t)*rad + ccy
m   = 0
repeat 24 {
  zt = clamp(zr*zr - zi*zi + cr, -4, 4)
  zi = clamp(2*zr*zi + ci, -4, 4)
  zr = zt
  m  = m + (zr*zr + zi*zi)
}
clamp(1 - m/120, 0, 1)`,
  },
  {
    // CURL: fbm でドメインワープした正弦の縞 → 大理石 / 墨流し
    file: "curl" + EXT,
    src: HEADER + `ox = cos(t)*.3
oy = sin(t)*.3
qx = fbm(x*3 + ox, y*3 + oy, 4)
qy = fbm(x*3 + 4.2, y*3 + 1.7, 4)
w  = fbm(x*3 + qx*2, y*3 + qy*2, 4)
.5 + .5*sin(x*20 + w*8 + t)`,
  },
  {
    // WORLEY: セルラーノイズ（最近傍距離）。細胞 / 石畳模様
    file: "worley" + EXT,
    src: HEADER + `u = x*6 + cos(t)*.4
v = y*6 + sin(t)*.4
1 - worley(u, v)`,
  },
];

// HEADER の view 行だけ差し替える（作品ごとに view を選ぶ音付き作例用。ヘッダ本体は SSoT）。
const soundHead = (view) => HEADER.replace(/view:\s*dither\(2\)/, `view:   ${view}`);

// ── GALLERY（音）: sound: を持つ AV 作例。視覚が amp/beat(n)/step(n)/decay を読み、音と
// 画がひとつのループ時計を共有する＝Alt+P で相乗効果。全作品を実コンパイラで検証済み
// （場の分散・音のピーク/RMS・NaN 無し・ループ端）。MP4 で書き出すと音も一緒に載る。
const SOUND_SAMPLES = [
  {
    // PULSAR: キック毎に衝撃波リングが広がる（ソナー）。芯＋アルペジオ
    file: "pulsar" + EXT,
    src: HEADER + `// sonar ping: a ring bursts out on
// every kick, over a bright core.
// an arpeggio sparkles up top. Alt+P.
d = dist(x, y, .5, .5)
p = beat(3)
edge = abs(d - p*.72)
lip = 1 - smoothstep(0, .06, edge)
ring = lip*(1 - p)
core = 1 - smoothstep(.03, .08, d)
clamp(core + ring*(.6 + .4*amp), 0, 1)

sound:
  kick = tri(hz(28)) * decay(beat(3))
  n = 60 + seq(step(12), 0, 7, 12, 7)
  arp = pulse(hz(n), .5)*decay(beat(12))
  kick*.62 + arp*.38`,
  },
  {
    // STEPPER: 見えるステップシーケンサ。各列=音符・高さ=音程・光る列=再生中
    file: "stepper" + EXT,
    src: HEADER + `// a step sequencer you can see: each
// column is a note, its height is the
// pitch, the lit one is playing. Alt+P.
n = 6
col = floor(x*n)
h = (2 + seq(col, 5, 0, 3, 7, 3, 10))/14
yb = 1 - y
fill = smoothstep(h + .02, h - .02, yb)
dcol = abs(col - step(n))
act = 1 - smoothstep(.5, 1.5, dcol)
fill*(.35 + .65*act)

sound:
  n = 48 + seq(step(6), 5, 0, 3, 7, 3, 10)
  lead = pulse(hz(n), .5)*decay(beat(6))
  bass = tri(hz(24)) * decay(beat(3))
  lead*.5 + bass*.5`,
  },
  {
    // BOUNCE: 床で弾む球。着地の瞬間にベースが鳴る（1 拍 1 バウンド）
    file: "bounce" + EXT,
    src: HEADER + `// a ball bounces on the floor; the
// bass thumps the instant it lands.
// one bounce per beat. Alt+P.
b = beat(4)
by = .82 - .58*abs(sin(pi*b))
db = dist(x, y, .5, by)
ball = 1 - smoothstep(.06, .10, db)
grnd = smoothstep(.90, .92, y)
clamp(ball + grnd*.5, 0, 1)

sound:
  n = 31 + seq(step(4), 0, 0, 5, 0)
  land = tri(hz(n)) * decay(beat(4))
  ping = pulse(hz(72), .25)*decay(beat(8))
  land*.7 + ping*.3`,
  },
  {
    // RAIN: 落ちて折り返すデジタルの雨。ハット＋雫。列は整数分スクロール＝継ぎ目なし
    file: "rain" + EXT,
    src: HEADER + `// digital rain: streaks fall and wrap
// as hats tick and plucks drip. cols
// scroll whole cells, so it loops clean.
// Alt+P.
col = floor(x*10)
drop = fract(y*3 - beat(3) + rnd(col, 0))
head = 1 - smoothstep(0, .22, drop)
lit = head*(.5 + .5*rnd(col, 7))
clamp(lit + amp*.15, 0, 1)

sound:
  hat = nz(1400) * decay(beat(12))
  n = 72 + seq(step(6), 0, 3, 7, 10, 7, 3)
  drip = tri(hz(n)) * decay(beat(6))
  hat*.5 + drip*.5`,
  },
  {
    // TUNNEL: 無限トンネルを進む同心リング（ハーフトーン）。転がるベース
    file: "tunnel" + EXT,
    src: soundHead("halftone(7)") + `// fly down an endless tunnel. rings
// rush toward you twice per loop over
// a rolling bass. Alt+P.
d = dist(x, y, .5, .5)
v = sin(5/(d + .12) - t*2)
clamp((v*.5 + .5)*(.55 + .45*amp), 0, 1)

sound:
  n = 31 + seq(step(4), 0, 0, 5, 7)
  bass = saw(hz(n)) * decay(beat(8))
  lead = pulse(hz(67), .5)*decay(beat(16))
  bass*.6 + lead*.4`,
  },
  {
    // STROBE: 半拍で反転し、スタブ和音ごとに明滅する市松（パンチ強め）
    file: "strobe" + EXT,
    src: HEADER + `// a checkerboard flips at the half-bar
// and flashes on every stab chord.
// bold and punchy. Alt+P.
n = 5
c = mod(floor(x*n) + floor(y*n), 2)
flip = mix(c, 1 - c, step(2))
flip*(.35 + .65*decay(beat(4)))

sound:
  a = pulse(hz(48), .5)
  b = pulse(hz(55), .5)
  c = pulse(hz(52), .5)
  (a + b + c)/3 * decay(beat(4))`,
  },
  {
    // ORBITS: 中心を巡る 5 つのメタボール。プラック毎に軌道が広がる
    file: "orbits" + EXT,
    src: HEADER + `// five metaballs swing around the
// center, breathing wider as the
// plucks ring out. Alt+P.
s = 0
repeat 5 as k {
  ang = t + k*(tau/5)
  rr = .34 + .06*decay(beat(5))
  cx = .5 + rr*cos(ang)
  cy = .5 + rr*sin(ang)
  dx = x - cx
  dy = y - cy
  s = s + .006/(dx*dx + dy*dy + .0008)
}
clamp(s, 0, 1)*(.6 + .4*amp)

sound:
  n = 55 + seq(step(6), 0, 3, 7, 10, 7, 3)
  pluck = pulse(hz(n), .35)*decay(beat(6))
  bass = tri(hz(31)) * decay(beat(3))
  pluck*.55 + bass*.45`,
  },
  {
    // SCOPE: 波形トレース。うねりの数＝音程（高い音ほど細かい波）。braille
    file: "scope" + EXT,
    src: soundHead("braille(2)") + `// an oscilloscope trace whose wobble
// count IS the pitch: higher note =
// tighter wave. the melody draws
// itself. Alt+P.
note = seq(step(6), 0, 3, 7, 12, 7, 3)
k = 5 + note
w = .5 + .3*sin(x*k + t*2)
dl = abs(y - w)
line = 1 - smoothstep(0, .05, dl)
clamp(line*(.55 + .45*amp), 0, 1)

sound:
  n = 60 + seq(step(6), 0, 3, 7, 12, 7, 3)
  lead = pulse(hz(n), .5)*decay(beat(6))
  sub = tri(hz(36)) * decay(beat(2))
  lead*.55 + sub*.45`,
  },
  {
    // HELIX: 上る音階に合わせ捩れる二重らせん。半回転ずれた 2 本の鎖
    file: "helix" + EXT,
    src: HEADER + `// a double helix twists as a scale
// climbs. two strands, half a turn
// apart, cross and part. Alt+P.
ph = t*2
s1 = .5 + .30*sin(y*tau*2 + ph)
s2 = .5 + .30*sin(y*tau*2 + ph + pi)
a = 1 - smoothstep(0, .045, abs(x - s1))
b = 1 - smoothstep(0, .045, abs(x - s2))
clamp((a + b)*(.55 + .45*amp), 0, 1)

sound:
  n = 52 + seq(step(6), 0, 2, 4, 7, 9, 11)
  lead = pulse(hz(n), .25)*decay(beat(6))
  bass = tri(hz(28)) * decay(beat(3))
  lead*.5 + bass*.5`,
  },
  {
    // MANDALA: 6 回対称の干渉波。1 周で 1 回転しプラック毎に発光
    file: "mandala" + EXT,
    src: HEADER + `// a six-fold mandala of interfering
// waves, turning one turn per loop and
// glowing on each pluck. Alt+P.
cx = x - .5
cy = y - .5
s = 0
repeat 6 as k {
  ang = k*(tau/6) + t
  u = cx*cos(ang) + cy*sin(ang)
  s = s + cos(u*26)
}
v = clamp(abs(s/6)*1.7, 0, 1)
v*(.45 + .55*decay(beat(6)))

sound:
  n = 57 + seq(step(6), 0, 4, 7, 11, 7, 4)
  bell = pulse(hz(n), .5)*decay(beat(6))
  drone = tri(hz(33)) * decay(beat(3))
  bell*.5 + drone*.5`,
  },
  {
    // RIPPLE: ドット格子。キック毎に中心から衝撃波が広がり通過セルが光る
    file: "ripple" + EXT,
    src: HEADER + `// a lattice of dots; a shockwave
// expands from center on each kick,
// lighting the cells it passes. Alt+P.
n = 9
cx = (floor(x*n) + .5)/n
cy = (floor(y*n) + .5)/n
dc = dist(cx, cy, .5, .5)
wave = 1 - decay(beat(4))
edge = abs(dc - wave*.7)
front = 1 - smoothstep(0, .16, edge)
gx = fract(x*n) - .5
gy = fract(y*n) - .5
gd = sqrt(gx*gx + gy*gy)
dot = 1 - smoothstep(.20, .30, gd)
dot*(.25 + .75*front)

sound:
  kick = tri(hz(29)) * decay(beat(4))
  n = 64 + seq(step(6), 0, 7, 5, 12, 7, 5)
  blip = pulse(hz(n), .5)*decay(beat(6))
  kick*.6 + blip*.4`,
  },
  {
    // SPIRAL: 内へ巻く 3 本腕の渦（1 周で 2 回転）。温かいベースパッド。ハーフトーン
    file: "spiral" + EXT,
    src: soundHead("halftone(6)") + `// a three-arm spiral winds inward,
// spinning twice per loop over a warm
// bass pad. Alt+P.
d = dist(x, y, .5, .5)
a = atan2(y - .5, x - .5)
v = sin(a*3 + d*20 - t*2)
m = smoothstep(.55, .08, d)
clamp((v*.5 + .5)*m*(.5 + .5*amp), 0, 1)

sound:
  pad = (tri(hz(40)) + saw(hz(47)))*.5
  pad = pad * decay(beat(2))
  n = 64 + seq(step(6), 0, 5, 7, 12, 7, 5)
  lead = pulse(hz(n), .5)*decay(beat(6))
  pad*.5 + lead*.5`,
  },
  {
    // WARP: 中心から放射状に伸びる星。1 周で折り返し、通り過ぎる時に明るくなる
    file: "warp" + EXT,
    src: HEADER + `// warp speed: stars streak from the
// center and wrap once per loop,
// brightening as they fly past. Alt+P.
s = 0
repeat 14 as k {
  a = rnd(k, 1)*tau
  r = fract(rnd(k, 3) + beat(1))
  cx = .5 + cos(a)*r*.55
  cy = .5 + sin(a)*r*.55
  dx = x - cx
  dy = y - cy
  s = s + .0009*r/(dx*dx + dy*dy + .0006)
}
clamp(s + amp*.15, 0, 1)

sound:
  n = 29 + seq(step(4), 0, 0, 7, 5)
  bass = saw(hz(n)) * decay(beat(4))
  n2 = 72 + seq(step(16), 0, 12, 7, 12)
  zap = pulse(hz(n2), .25)*decay(beat(16))
  bass*.6 + zap*.4`,
  },
  {
    // JELLY: 5 つの瘤で縁が波打つゼリー玉。拍毎に全体が膨らむ。ハーフトーン
    file: "jelly" + EXT,
    src: soundHead("halftone(6)") + `// a jelly blob: its rim ripples in
// five lobes and the whole body swells
// on every beat. Alt+P.
a = atan2(y - .5, x - .5)
d = dist(x, y, .5, .5)
rim = .05*sin(a*5 + t*2)
pump = .07*decay(beat(4))
r = .26 + rim + pump
1 - smoothstep(r, r + .03, d)

sound:
  wob = saw(hz(33 + 3*sin(t*2)))
  wob = wob * decay(beat(4))
  n = 60 + seq(step(6), 0, 5, 7, 3, 10, 7)
  bloop = pulse(hz(n), .5)*decay(beat(8))
  wob*.55 + bloop*.45`,
  },
  {
    // PENDULUM: 1 周で 1 往復する振り子。最下点でチクタク鳴る。棒は数珠つなぎ
    file: "pendulum" + EXT,
    src: HEADER + `// a pendulum swings once per loop and
// ticks as it passes the bottom. the
// rod is a string of beads. Alt+P.
ang = sin(t)*.7
rod = 0
repeat 7 as k {
  f = k/6
  rx = .5 + sin(ang)*.62*f
  ry = .16 + cos(ang)*.62*f
  dr = dist(x, y, rx, ry)
  bead = 1 - smoothstep(.016, .032, dr)
  rod = max(rod, bead)
}
bx = .5 + sin(ang)*.62
by = .16 + cos(ang)*.62
db = dist(x, y, bx, by)
bob = 1 - smoothstep(.05, .085, db)
clamp(max(rod, bob), 0, 1)

sound:
  n = 69 + seq(step(2), 0, 5)
  tick = pulse(hz(n), .25)*decay(beat(2))
  sub = tri(hz(33)) * decay(beat(2))
  tick*.5 + sub*.5`,
  },
  {
    // VU: 音量で呼吸する円盤。大きい音でリングが膨らみ、静かだと縮む。ハーフトーン
    file: "vu" + EXT,
    src: soundHead("halftone(8)") + `// a disc that breathes with loudness:
// the ring swells when the music is
// loud, settles when it's quiet. Alt+P.
d = dist(x, y, .5, .5)
lvl = .12 + .32*amp + .10*decay(beat(4))
disc = 1 - smoothstep(lvl, lvl + .03, d)
rd = abs(d - lvl - .14)
ring = 1 - smoothstep(0, .025, rd)
clamp(disc + ring*.7, 0, 1)

sound:
  n = 50 + seq(step(6), 0, 3, 7, 10, 7, 3)
  lead = pulse(hz(n), .25)*decay(beat(6))
  kick = tri(hz(30)) * decay(beat(4))
  lead*.5 + kick*.5`,
  },
];

let _seeded = false;

// ── サンプル種まき（無ければ書く。既存ユーザーへの追加も安全に backfill） ──
export function seedSamples() {
  if (_seeded) return;
  _seeded = true;
  VFS.mkdir(HOME_DIR);
  const seedInto = (dir, list) => {
    VFS.mkdir(dir);
    for (const s of list) {
      const p = `${dir}/${s.file}`;
      if (!VFS.exists(p)) VFS.writeFile(p, s.src);
    }
  };
  seedInto(LEARN_DIR, LEARN_SAMPLES); // 番号順チュートリアル
  seedInto(GALLERY_DIR, GALLERY_SAMPLES); // 作例ショーケース
  seedInto(SOUND_DIR, SOUND_SAMPLES); // 音付き AV 作例（Alt+P）
}
