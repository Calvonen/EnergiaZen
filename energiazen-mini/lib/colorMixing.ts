export function hexToRgb(hexColor: string) {
  const normalizedColor = hexColor.replace("#", "");

  return {
    r: parseInt(normalizedColor.slice(0, 2), 16),
    g: parseInt(normalizedColor.slice(2, 4), 16),
    b: parseInt(normalizedColor.slice(4, 6), 16),
  };
}

export function rgbToHex({ r, g, b }: { r: number; g: number; b: number }) {
  const toHex = (channel: number) =>
    Math.round(channel).toString(16).padStart(2, "0");

  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

export function mixColors(
  startColor: string,
  endColor: string,
  ratio: number,
) {
  const start = hexToRgb(startColor);
  const end = hexToRgb(endColor);

  return rgbToHex({
    r: start.r + (end.r - start.r) * ratio,
    g: start.g + (end.g - start.g) * ratio,
    b: start.b + (end.b - start.b) * ratio,
  });
}
