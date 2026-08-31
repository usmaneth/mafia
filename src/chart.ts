/**
 * Small terminal charts.
 *
 * Drawn with block characters rather than an image protocol. Images work only
 * where the terminal and any multiplexer both cooperate; blocks render the same
 * everywhere, including over SSH and inside tmux without passthrough.
 */

const BLOCKS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"] as const;

/** A one-line sparkline. Flat input draws a flat line rather than nothing. */
export function sparkline(values: number[], width = 24): string {
  if (!values.length) return "";
  const points = values.length > width
    // Average within buckets rather than sampling, so a spike cannot vanish
    // between two chosen points.
    ? Array.from({ length: width }, (_, index) => {
      const from = Math.floor((index * values.length) / width);
      const to = Math.max(from + 1, Math.floor(((index + 1) * values.length) / width));
      const slice = values.slice(from, to);
      return slice.reduce((sum, value) => sum + value, 0) / slice.length;
    })
    : values;
  const min = Math.min(...points);
  const max = Math.max(...points);
  const span = max - min;
  return points.map((value) => {
    if (span === 0) return BLOCKS[3];
    const index = Math.round(((value - min) / span) * (BLOCKS.length - 1));
    return BLOCKS[Math.max(0, Math.min(BLOCKS.length - 1, index))];
  }).join("");
}

/** A horizontal bar, filled proportionally to `fraction` of `width`. */
export function bar(fraction: number, width = 20, filled = "█", empty = "·"): string {
  const clamped = Math.max(0, Math.min(1, Number.isFinite(fraction) ? fraction : 0));
  const cells = Math.round(clamped * width);
  return `${filled.repeat(cells)}${empty.repeat(width - cells)}`;
}

export interface BarRow {
  label: string;
  value: number;
  /** Shown after the bar. Defaults to the value. */
  note?: string;
}

/**
 * A labelled bar chart scaled to the largest row.
 *
 * Scaling to the maximum rather than to a fixed ceiling keeps the shape of the
 * comparison visible when every value is small.
 */
export function barChart(rows: BarRow[], width = 24, labelWidth = 18): string {
  if (!rows.length) return "";
  const max = Math.max(...rows.map((row) => row.value), 0);
  return rows.map((row) => {
    const label = row.label.length > labelWidth
      ? `${row.label.slice(0, labelWidth - 1)}~`
      : row.label.padEnd(labelWidth);
    return `${label} ${bar(max ? row.value / max : 0, width)} ${row.note ?? row.value}`;
  }).join("\n");
}

/**
 * A compact gauge for a value that has a limit, such as a quota window.
 *
 * The marker sits where the value falls, so a bar close to full reads as urgent
 * without needing colour, which does not survive every terminal.
 */
export function gauge(fraction: number, width = 20): string {
  const clamped = Math.max(0, Math.min(1, fraction));
  const cells = Math.round(clamped * width);
  const critical = clamped >= 0.95;
  const warn = clamped >= 0.75;
  const fill = critical ? "▓" : warn ? "▒" : "░";
  return `[${fill.repeat(cells)}${" ".repeat(width - cells)}]`;
}

/** Group values into `buckets` counts by timestamp, oldest first. */
export function histogram(timestamps: string[], buckets = 24, now = Date.now(), windowMs = 24 * 3600_000): number[] {
  const counts = new Array(buckets).fill(0) as number[];
  const start = now - windowMs;
  for (const stamp of timestamps) {
    const at = new Date(stamp).getTime();
    if (!Number.isFinite(at) || at < start || at > now) continue;
    const index = Math.min(buckets - 1, Math.floor(((at - start) / windowMs) * buckets));
    counts[index]!++;
  }
  return counts;
}
