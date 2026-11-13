// Convert any photo to the DJI Goggles 3 desk-background format:
// 1920x1080, 24-bit uncompressed BMP (BGR, bottom-up, 54-byte header, no palette).
// Verified against /data/screendesk_1920.bmp (size = 54 + 1920*1080*3 = 6220854).

export const SCREEN_W = 1920;
export const SCREEN_H = 1080;

function loadImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("cannot load image")); };
    img.src = url;
  });
}

function drawFitted(
  ctx: CanvasRenderingContext2D,
  img: HTMLImageElement,
  fit: "cover" | "contain",
): void {
  const scale =
    fit === "cover"
      ? Math.max(SCREEN_W / img.width, SCREEN_H / img.height)
      : Math.min(SCREEN_W / img.width, SCREEN_H / img.height);
  const w = img.width * scale;
  const h = img.height * scale;
  ctx.drawImage(img, (SCREEN_W - w) / 2, (SCREEN_H - h) / 2, w, h);
}

/// Pack RGBA pixels into a 24-bit BMP (BGR, bottom-up). Row size 1920*3 is a
/// multiple of 4, so no per-row padding is needed.
export function bmp24FromRgba(rgba: Uint8ClampedArray | Uint8Array, w: number, h: number): Uint8Array<ArrayBuffer> {
  const rowSize = w * 3;
  const pixels = rowSize * h;
  const size = 54 + pixels;
  const buf = new Uint8Array(size);
  const dv = new DataView(buf.buffer);
  buf[0] = 0x42; // 'B'
  buf[1] = 0x4d; // 'M'
  dv.setUint32(2, size, true);
  dv.setUint32(10, 54, true); // pixel data offset
  dv.setUint32(14, 40, true); // BITMAPINFOHEADER size
  dv.setInt32(18, w, true);
  dv.setInt32(22, h, true); // positive height = bottom-up (matches stock)
  dv.setUint16(26, 1, true); // planes
  dv.setUint16(28, 24, true); // bpp
  dv.setUint32(34, pixels, true); // image size
  let o = 54;
  for (let y = h - 1; y >= 0; y--) {
    let src = y * w * 4;
    for (let x = 0; x < w; x++) {
      buf[o++] = rgba[src + 2]; // B
      buf[o++] = rgba[src + 1]; // G
      buf[o++] = rgba[src]; // R
      src += 4;
    }
  }
  return buf;
}

/// Render a preview into a (small) canvas showing how the image will be framed.
export async function previewInto(
  canvas: HTMLCanvasElement,
  file: File,
  fit: "cover" | "contain",
): Promise<void> {
  const img = await loadImage(file);
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  // preview keeps the 16:9 frame; draw scaled down
  const pw = canvas.width;
  const ph = canvas.height;
  const scale =
    fit === "cover" ? Math.max(pw / img.width, ph / img.height) : Math.min(pw / img.width, ph / img.height);
  const w = img.width * scale;
  const h = img.height * scale;
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, pw, ph);
  ctx.drawImage(img, (pw - w) / 2, (ph - h) / 2, w, h);
}

/// Convert a photo File to the 1920x1080 24-bit BMP bytes.
export async function toScreenBmp(file: File, fit: "cover" | "contain" = "cover"): Promise<Uint8Array<ArrayBuffer>> {
  const img = await loadImage(file);
  const canvas = document.createElement("canvas");
  canvas.width = SCREEN_W;
  canvas.height = SCREEN_H;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("no canvas 2d context");
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, SCREEN_W, SCREEN_H);
  drawFitted(ctx, img, fit);
  const { data } = ctx.getImageData(0, 0, SCREEN_W, SCREEN_H);
  return bmp24FromRgba(data, SCREEN_W, SCREEN_H);
}

// Decode a raw BGRA frame (LiveView, 1920x1080, stride = width*4, no padding)
// into a canvas. BGRA -> RGBA, alpha forced opaque.
export function bgraToCanvas(
  bytes: Uint8Array,
  canvas: HTMLCanvasElement,
  w = SCREEN_W,
  h = SCREEN_H,
): void {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const img = ctx.createImageData(w, h);
  const d = img.data;
  const n = Math.min(w * h, Math.floor(bytes.length / 4));
  for (let i = 0; i < n; i++) {
    const s = i * 4;
    d[s] = bytes[s + 2]; // R <- B
    d[s + 1] = bytes[s + 1]; // G
    d[s + 2] = bytes[s]; // B <- R
    d[s + 3] = 255; // opaque
  }
  // draw at native size onto a possibly-smaller canvas via a temp
  const tmp = document.createElement("canvas");
  tmp.width = w;
  tmp.height = h;
  tmp.getContext("2d")!.putImageData(img, 0, 0);
  ctx.drawImage(tmp, 0, 0, canvas.width, canvas.height);
}
