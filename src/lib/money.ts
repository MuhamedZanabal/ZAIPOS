export type Fils = number;

const FILS_PER_BHD = 1000;

function assertFiniteNumber(value: number, label: string): number {
  if (!Number.isFinite(value)) throw new Error(`${label} must be a finite number`);
  return value;
}

export function assertFils(value: number, label = "fils"): Fils {
  if (!Number.isSafeInteger(value)) {
    throw new Error(`${label} must be a safe integer number of fils`);
  }
  return value;
}

function roundHalfAwayFromZero(value: number): number {
  assertFiniteNumber(value, "value");
  if (value === 0) return 0;
  const sign = value < 0 ? -1 : 1;
  return sign * Math.floor(Math.abs(value) + 0.5 + Number.EPSILON);
}

export function bhdToFils(value: number | string): Fils {
  const parsed = typeof value === "string" ? Number(value.trim()) : value;
  assertFiniteNumber(parsed, "BHD value");
  const fils = roundHalfAwayFromZero(parsed * FILS_PER_BHD);
  return assertFils(fils, "converted BHD value");
}

export function filsToBhd(fils: Fils): number {
  return assertFils(fils) / FILS_PER_BHD;
}

export function addFils(...values: Fils[]): Fils {
  const total = values.reduce((sum, value) => sum + assertFils(value), 0);
  return assertFils(total, "fils total");
}

export function subtractFils(minuend: Fils, subtrahend: Fils): Fils {
  return assertFils(assertFils(minuend) - assertFils(subtrahend), "fils difference");
}

export function multiplyFils(fils: Fils, multiplier: number): Fils {
  assertFils(fils);
  assertFiniteNumber(multiplier, "multiplier");
  return assertFils(roundHalfAwayFromZero(fils * multiplier), "fils product");
}

export function percentageOfFils(fils: Fils, percent: number): Fils {
  assertFils(fils);
  assertFiniteNumber(percent, "percent");
  return assertFils(roundHalfAwayFromZero((fils * percent) / 100), "percentage fils");
}

export function clampFils(value: Fils, min: Fils, max: Fils): Fils {
  assertFils(value);
  assertFils(min);
  assertFils(max);
  if (min > max) throw new Error("minimum fils cannot exceed maximum fils");
  return Math.min(max, Math.max(min, value));
}

export function sumBhdAsFils(values: Array<number | string>): Fils {
  return addFils(...values.map(bhdToFils));
}
