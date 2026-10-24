// Analogue rev counter with digital speed, gear, shift light and a nitro ring.
// Built after warehouse-racing's speedometer, in plain SVG/DOM without React; per-frame values
// are written straight into the elements.

const SVG = 'http://www.w3.org/2000/svg';
const CX = 100;
const CY = 100;
const A0 = 135; // 0 rpm at bottom left
const SWEEP = 270;

const rad = (d: number) => (d * Math.PI) / 180;
const f1 = (n: number) => n.toFixed(1);
const pt = (r: number, v01: number): [number, number] => {
  const a = rad(A0 + SWEEP * v01);
  return [CX + r * Math.cos(a), CY + r * Math.sin(a)];
};
function arc(r: number, v0: number, v1: number) {
  const [x0, y0] = pt(r, v0);
  const [x1, y1] = pt(r, v1);
  return `M${f1(x0)} ${f1(y0)} A${r} ${r} 0 ${(v1 - v0) * SWEEP > 180 ? 1 : 0} 1 ${f1(x1)} ${f1(y1)}`;
}

export interface TachoReading {
  rpm: number;
  gear: number; // -1 = reverse
  kmh: number;
  nitro: number; // 0..1
  boosting: boolean;
  limiter: boolean;
}

export class Tacho {
  private needle: SVGGElement;
  private gear: HTMLElement;
  private speed: HTMLElement;
  private nitroArc: SVGPathElement;
  private nitroLen: number;
  private shiftLight: SVGCircleElement;
  private root: HTMLElement;
  private shown = 0;
  private burn = 0;
  private last = { kmh: -1, gear: '', nitro: -1, shift: false, burn: -1 };

  private maxRpm: number;
  private redRpm: number;

  constructor(root: HTMLElement, maxRpm: number, redRpm: number) {
    this.root = root;
    this.redRpm = redRpm;
    const scaleMax = Math.ceil(maxRpm / 1000) * 1000;
    const v = (rpm: number) => rpm / scaleMax;
    let ticks = '';
    for (let k = 0; k <= scaleMax; k += 500) {
      const major = k % 1000 === 0;
      const red = k >= redRpm;
      const [x0, y0] = pt(80, v(k));
      const [x1, y1] = pt(major ? 69 : 74, v(k));
      ticks += `<line x1="${f1(x0)}" y1="${f1(y0)}" x2="${f1(x1)}" y2="${f1(y1)}" stroke="${red ? '#ff5b4f' : major ? '#f2f5fa' : '#8b97a8'}" stroke-width="${major ? 3 : 1.6}" stroke-linecap="round"/>`;
      if (major) {
        const [lx, ly] = pt(57, v(k));
        ticks += `<text x="${f1(lx)}" y="${f1(ly)}" fill="${red ? '#ff7a70' : '#dfe6f0'}">${k / 1000}</text>`;
      }
    }
    root.innerHTML = `
      <div class="tacho-halo"></div>
      <svg viewBox="0 0 200 200" aria-hidden="true">
        <defs>
          <radialGradient id="tacho-face" cx="50%" cy="40%" r="65%"><stop offset="0" stop-color="#202733"/><stop offset="1" stop-color="#0b0e13"/></radialGradient>
        </defs>
        <circle cx="100" cy="100" r="97" fill="#05070acc"/>
        <path class="tacho-nitro-track" d="${arc(91, 0, 1)}"/>
        <path class="tacho-nitro" d="${arc(91, 0, 1)}"/>
        <circle cx="100" cy="100" r="85" fill="url(#tacho-face)" stroke="#ffffff22" stroke-width="1.5"/>
        <path d="${arc(80, v(redRpm), v(scaleMax))}" fill="none" stroke="#ff3b30" stroke-width="5" opacity=".9"/>
        <g class="tacho-ticks">${ticks}</g>
        <text x="100" y="62" class="tacho-unit">×1000 /min</text>
        <circle class="tacho-shift" cx="100" cy="40" r="4.5"/>
        <g class="tacho-needle"><g transform="rotate(${A0} ${CX} ${CY})">
          <path d="M${CX - 14} ${CY - 2.2} L${CX + 76} ${CY - 0.8} L${CX + 76} ${CY + 0.8} L${CX - 14} ${CY + 2.2} Z" fill="#ff4a2e"/>
        </g></g>
        <circle cx="100" cy="100" r="20" fill="#0b0e13" stroke="#ffffff40" stroke-width="1.5"/>
      </svg>
      <div class="tacho-gear">N</div>
      <div class="tacho-speed"><span>0</span><small>km/h</small></div>`;
    this.needle = root.querySelector('.tacho-needle')!;
    this.gear = root.querySelector('.tacho-gear')!;
    this.speed = root.querySelector('.tacho-speed span')!;
    this.nitroArc = root.querySelector('.tacho-nitro')!;
    this.shiftLight = root.querySelector('.tacho-shift')!;
    this.nitroLen = (SWEEP / 360) * 2 * Math.PI * 91;
    this.nitroArc.style.strokeDasharray = `${this.nitroLen} ${this.nitroLen}`;
    this.maxRpm = scaleMax;
  }

  update(r: TachoReading, dt: number, time: number) {
    // Needle has a little inertia; the limiter makes it bounce, nitro makes it tremble.
    const target = r.rpm / this.maxRpm;
    this.shown += (target - this.shown) * Math.min(1, dt * 18);
    let a = this.shown;
    if (r.limiter) a -= 0.012 * (0.5 + 0.5 * Math.sin(time * 60));
    this.burn += ((r.boosting ? 1 : 0) - this.burn) * Math.min(1, dt * (r.boosting ? 12 : 2.5));
    if (this.burn > 0.05) a += 0.006 * this.burn * Math.sin(time * 70);
    this.needle.setAttribute('transform', `rotate(${f1(Math.max(0, a) * SWEEP)} ${CX} ${CY})`);

    const L = this.last;
    const kmh = Math.round(r.kmh);
    if (kmh !== L.kmh) this.speed.textContent = String((L.kmh = kmh));
    const gear = r.gear < 0 ? 'R' : r.kmh < 1 && r.rpm < 1000 ? 'N' : String(r.gear);
    if (gear !== L.gear) this.gear.textContent = L.gear = gear;
    if (Math.abs(r.nitro - L.nitro) > 0.002) {
      L.nitro = r.nitro;
      this.nitroArc.style.strokeDashoffset = f1(this.nitroLen * (1 - r.nitro));
    }
    const shift = r.rpm > this.redRpm - 350;
    if (shift !== L.shift) this.shiftLight.classList.toggle('on', (L.shift = shift));
    if (Math.abs(this.burn - L.burn) > 0.01) {
      L.burn = this.burn;
      this.root.style.setProperty('--burn', this.burn.toFixed(2));
    }
  }
}
