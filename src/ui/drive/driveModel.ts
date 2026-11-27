export function formatSpeedKph(speedKph: number): string {
  if (!Number.isFinite(speedKph) || speedKph < 0) {
    return '0';
  }
  return String(Math.round(speedKph));
}

export function formatGearLabel(gear: number): string {
  if (gear < 0) {
    return 'R';
  }
  if (gear === 0) {
    return 'N';
  }
  return String(gear);
}

export function formatElapsedTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return '00:00.00';
  }
  const totalCs = Math.floor(seconds * 100);
  const cs = totalCs % 100;
  const totalSec = Math.floor(totalCs / 100);
  const sec = totalSec % 60;
  const min = Math.floor(totalSec / 60);
  return `${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

export function formatRpm(rpm: number): string {
  if (!Number.isFinite(rpm) || rpm <= 0) {
    return '0';
  }
  return String(Math.round(rpm));
}

export function computeRpmFillFraction(rpm: number, redlineRpm: number): number {
  if (!Number.isFinite(rpm) || !Number.isFinite(redlineRpm) || redlineRpm <= 0) {
    return 0;
  }
  const ratio = rpm / redlineRpm;
  if (ratio <= 0) {
    return 0;
  }
  if (ratio >= 1) {
    return 1;
  }
  return ratio;
}

export function isRedlineRpm(rpm: number, redlineRpm: number): boolean {
  if (!Number.isFinite(rpm) || !Number.isFinite(redlineRpm) || redlineRpm <= 0) {
    return false;
  }
  return rpm >= redlineRpm * 0.92;
}
