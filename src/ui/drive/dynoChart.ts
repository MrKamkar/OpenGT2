import { type CarPhysicsSpec } from '../../physics';
import { type DynoCurveResult, computeDynoCurve } from '../../physics';

export interface DynoChartSummary {
  readonly peakPsLabel: string;
  readonly peakKwLabel: string;
  readonly peakTorqueLabel: string;
  readonly massAndRatioLabel: string;
}

/**
 * Formats concise peak dyno metrics for display beneath the Drive dyno chart.
 */
export function formatDynoSummary(curve: DynoCurveResult): DynoChartSummary {
  const peakPs = Math.round(curve.peakPowerPs);
  const peakPsRpm = Math.round(curve.peakPowerRpm);
  const peakKw = curve.peakPowerKw.toFixed(1);
  const peakNm = Math.round(curve.peakTorqueNm);
  const peakNmRpm = Math.round(curve.peakTorqueRpm);
  const massKg = Math.round(curve.massKg);
  const psPerTonne = Math.round(curve.powerToWeightPsPerTonne);
  return {
    peakPsLabel: `${String(peakPs)} PS @ ${String(peakPsRpm)} rpm`,
    peakKwLabel: `${peakKw} kW`,
    peakTorqueLabel: `${String(peakNm)} N·m @ ${String(peakNmRpm)} rpm`,
    massAndRatioLabel: `${String(massKg)} kg (${String(psPerTonne)} PS/t)`,
  };
}

export function buildDynoCurveFromSpec(spec: CarPhysicsSpec): DynoCurveResult {
  return computeDynoCurve(spec, 45);
}

/**
 * Renders Torque (`N·m`) and Power (`PS`) curves vs RPM onto a 2D `<canvas>` using standard UI fonts,
 * with an optional live engine RPM marker when driving.
 */
export function renderDynoChart(
  canvas: HTMLCanvasElement,
  curve: DynoCurveResult,
  currentRpm?: number,
): void {
  const ctx = canvas.getContext('2d');
  if (ctx === null) {
    return;
  }

  const w = Math.max(160, canvas.width);
  const h = Math.max(100, canvas.height);

  ctx.clearRect(0, 0, w, h);

  // Panel background
  ctx.fillStyle = '#0d1421';
  ctx.fillRect(0, 0, w, h);

  const padLeft = 32;
  const padRight = 32;
  const padTop = 18;
  const padBottom = 22;
  const plotW = Math.max(20, w - padLeft - padRight);
  const plotH = Math.max(20, h - padTop - padBottom);

  const minRpm = curve.minRpm;
  const maxRpm = Math.max(minRpm + 500, curve.maxRpm);
  const maxPs = Math.max(20, Math.ceil((curve.peakPowerPs * 1.12) / 10) * 10);
  const maxNm = Math.max(20, Math.ceil((curve.peakTorqueNm * 1.12) / 10) * 10);

  const xForRpm = (rpm: number): number =>
    padLeft + ((rpm - minRpm) / (maxRpm - minRpm)) * plotW;
  const yForPs = (ps: number): number =>
    padTop + plotH - Math.min(1, Math.max(0, ps / maxPs)) * plotH;
  const yForNm = (nm: number): number =>
    padTop + plotH - Math.min(1, Math.max(0, nm / maxNm)) * plotH;

  // Gridlines
  ctx.strokeStyle = 'rgba(148, 163, 184, 0.16)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let i = 0; i <= 4; i++) {
    const gy = padTop + (plotH * i) / 4;
    ctx.moveTo(padLeft, gy);
    ctx.lineTo(padLeft + plotW, gy);
  }
  for (let i = 0; i <= 4; i++) {
    const gx = padLeft + (plotW * i) / 4;
    ctx.moveTo(gx, padTop);
    ctx.lineTo(gx, padTop + plotH);
  }
  ctx.stroke();

  // Axes border
  ctx.strokeStyle = 'rgba(148, 163, 184, 0.35)';
  ctx.strokeRect(padLeft, padTop, plotW, plotH);

  // Redline zone tint (92%..100% redline)
  const redlineStartX = xForRpm(curve.redlineRpm * 0.92);
  ctx.fillStyle = 'rgba(239, 68, 68, 0.12)';
  ctx.fillRect(redlineStartX, padTop, Math.max(0, padLeft + plotW - redlineStartX), plotH);

  // Torque curve (amber)
  if (curve.samples.length >= 2) {
    ctx.strokeStyle = '#f59e0b';
    ctx.lineWidth = 2;
    ctx.beginPath();
    curve.samples.forEach((pt, idx) => {
      const px = xForRpm(pt.rpm);
      const py = yForNm(pt.torqueNm);
      if (idx === 0) {
        ctx.moveTo(px, py);
      } else {
        ctx.lineTo(px, py);
      }
    });
    ctx.stroke();

    // Power curve (cyan)
    ctx.strokeStyle = '#38bdf8';
    ctx.lineWidth = 2;
    ctx.beginPath();
    curve.samples.forEach((pt, idx) => {
      const px = xForRpm(pt.rpm);
      const py = yForPs(pt.powerPs);
      if (idx === 0) {
        ctx.moveTo(px, py);
      } else {
        ctx.lineTo(px, py);
      }
    });
    ctx.stroke();
  }

  // Live RPM cursor line
  if (currentRpm !== undefined && Number.isFinite(currentRpm)) {
    const clampedRpm = Math.min(maxRpm, Math.max(minRpm, currentRpm));
    const cx = xForRpm(clampedRpm);
    ctx.strokeStyle = 'rgba(248, 250, 252, 0.72)';
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(cx, padTop);
    ctx.lineTo(cx, padTop + plotH);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // Legend + axis labels
  ctx.font = '10px system-ui, -apple-system, sans-serif';
  ctx.textBaseline = 'top';
  ctx.fillStyle = '#38bdf8';
  ctx.textAlign = 'left';
  ctx.fillText(`PS (${String(maxPs)})`, 4, 4);

  ctx.fillStyle = '#f59e0b';
  ctx.textAlign = 'right';
  ctx.fillText(`N·m (${String(maxNm)})`, w - 4, 4);

  ctx.fillStyle = '#94a3b8';
  ctx.textBaseline = 'bottom';
  ctx.textAlign = 'left';
  ctx.fillText(`${(minRpm / 1000).toFixed(1)}k`, padLeft, h - 3);
  ctx.textAlign = 'center';
  ctx.fillText('RPM', padLeft + plotW * 0.5, h - 3);
  ctx.textAlign = 'right';
  ctx.fillText(`${(maxRpm / 1000).toFixed(1)}k`, padLeft + plotW, h - 3);
}
