/**
 * Builds a one-page PDF containing a canvas image scaled to fill the page, like Google Sheets'
 * "fit to width" export. The image is stored losslessly (Flate), so text stays sharp.
 */

const A4_PORTRAIT = { width: 595.28, height: 841.89 }; // points

export type PdfOptions = {
  /** Page margin in points (default 18pt = 0.25in). */
  margin?: number;
  title?: string;
  /** Page colour behind the image, as a hex string (default white). */
  pageColor?: string;
};

function hexToPdfRgb(hex: string): string {
  const value = hex.replace("#", "");
  return [0, 2, 4].map((offset) => (parseInt(value.slice(offset, offset + 2), 16) / 255).toFixed(3)).join(" ");
}

async function deflate(data: Uint8Array): Promise<Uint8Array> {
  // "deflate" here is the zlib format, which is exactly what PDF's FlateDecode expects.
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new CompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function canvasToRgb(canvas: HTMLCanvasElement): Uint8Array {
  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("Unable to read the report image.");
  }
  const rgba = context.getImageData(0, 0, canvas.width, canvas.height).data;
  const rgb = new Uint8Array(canvas.width * canvas.height * 3);
  for (let source = 0, target = 0; source < rgba.length; source += 4, target += 3) {
    // Flatten any transparency onto white.
    const alpha = rgba[source + 3] / 255;
    rgb[target] = Math.round(rgba[source] * alpha + 255 * (1 - alpha));
    rgb[target + 1] = Math.round(rgba[source + 1] * alpha + 255 * (1 - alpha));
    rgb[target + 2] = Math.round(rgba[source + 2] * alpha + 255 * (1 - alpha));
  }
  return rgb;
}

function pdfString(text: string): string {
  return `(${text.replace(/[\\()]/g, (char) => `\\${char}`).replace(/[^\x20-\x7e]/g, "")})`;
}

/** Height-to-width ratio of the printable area, for sizing content to fill the page. */
export function printableAspect(margin = 18): number {
  return (A4_PORTRAIT.height - margin * 2) / (A4_PORTRAIT.width - margin * 2);
}

/** Fits the image to the page width (and height, if it is very tall), top-aligned and centred. */
export function fitOnPage(
  imageWidth: number,
  imageHeight: number,
  margin: number
): { x: number; y: number; width: number; height: number } {
  const availableWidth = A4_PORTRAIT.width - margin * 2;
  const availableHeight = A4_PORTRAIT.height - margin * 2;
  const scale = Math.min(availableWidth / imageWidth, availableHeight / imageHeight);
  const width = imageWidth * scale;
  const height = imageHeight * scale;
  return {
    x: (A4_PORTRAIT.width - width) / 2,
    y: A4_PORTRAIT.height - margin - height,
    width,
    height
  };
}

export async function canvasToPdf(canvas: HTMLCanvasElement, options: PdfOptions = {}): Promise<Blob> {
  const margin = options.margin ?? 18;
  const pixels = await deflate(canvasToRgb(canvas));
  const box = fitOnPage(canvas.width, canvas.height, margin);
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const offsets: number[] = [];
  let length = 0;
  const push = (part: string | Uint8Array) => {
    const bytes = typeof part === "string" ? encoder.encode(part) : part;
    chunks.push(bytes);
    length += bytes.length;
  };
  const startObject = (id: number) => {
    offsets[id] = length;
    push(`${id} 0 obj\n`);
  };

  const background = options.pageColor
    ? `q\n${hexToPdfRgb(options.pageColor)} rg\n0 0 ${A4_PORTRAIT.width} ${A4_PORTRAIT.height} re\nf\nQ\n`
    : "";
  const content = `${background}q\n${box.width.toFixed(2)} 0 0 ${box.height.toFixed(2)} ${box.x.toFixed(2)} ${box.y.toFixed(2)} cm\n/Im0 Do\nQ\n`;

  push("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n");
  startObject(1);
  push("<< /Type /Catalog /Pages 2 0 R >>\nendobj\n");
  startObject(2);
  push("<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n");
  startObject(3);
  push(
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${A4_PORTRAIT.width} ${A4_PORTRAIT.height}] ` +
      "/Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>\nendobj\n"
  );
  startObject(4);
  push(
    `<< /Type /XObject /Subtype /Image /Width ${canvas.width} /Height ${canvas.height} ` +
      `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /Length ${pixels.length} >>\nstream\n`
  );
  push(pixels);
  push("\nendstream\nendobj\n");
  startObject(5);
  push(`<< /Length ${content.length} >>\nstream\n${content}endstream\nendobj\n`);
  startObject(6);
  push(`<< /Title ${pdfString(options.title || "DKP update")} /Producer (DK Weekly DKP) >>\nendobj\n`);

  const xrefOffset = length;
  push(`xref\n0 7\n0000000000 65535 f \n`);
  for (let id = 1; id <= 6; id += 1) {
    push(`${String(offsets[id]).padStart(10, "0")} 00000 n \n`);
  }
  push(`trailer\n<< /Size 7 /Root 1 0 R /Info 6 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`);
  return new Blob(chunks as BlobPart[], { type: "application/pdf" });
}
