// Human-readable file sizes in the page's locale ("2 MB", "1,4 Mo", "500 kB").
// Sizes are decimal (1 MB = 1,000,000 bytes), the stricter reading of an
// upload limit: a file that fits here also fits a 1024-based check.

const lang = document.documentElement.lang || 'en';

function unitFormat(unit, maximumFractionDigits) {
  try {
    return new Intl.NumberFormat(lang, { style: 'unit', unit, unitDisplay: 'short', maximumFractionDigits });
  } catch (_) {
    // No unit support: fall back to a plain number with a Latin suffix.
    const suffix = unit === 'megabyte' ? 'MB' : 'kB';
    const plain = new Intl.NumberFormat(lang, { maximumFractionDigits });
    return { format: (n) => `${plain.format(n)} ${suffix}` };
  }
}

const megabytes = unitFormat('megabyte', 1);
const kilobytes = unitFormat('kilobyte', 0);

export function formatBytes(bytes) {
  // From 999,500 bytes the kilobyte figure would round up to "1,000 KB".
  if (bytes >= 999_500) return megabytes.format(bytes / 1_000_000);
  return kilobytes.format(Math.max(1, Math.round(bytes / 1000)));
}
