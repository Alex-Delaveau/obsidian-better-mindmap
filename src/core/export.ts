/**
 * Image export helpers: standalone SVG → PNG (canvas) and PDF.
 *
 * PDF: on desktop the SVG is printed by Electron (vector output, real text);
 * elsewhere, or if that fails, the PNG rendering is wrapped in a minimal PDF.
 */

export type ExportFormat = "svg" | "png" | "pdf";

export interface ExportedSvg {
    /** Serialized standalone SVG document. */
    svg: string;
    /** Size in CSS pixels. */
    width: number;
    height: number;
    /** Opaque background colour, or null for transparent. */
    background: string | null;
}

/** Rasterize a standalone SVG into a PNG or JPEG blob at `scale`× its CSS size. */
export async function rasterize(doc: ExportedSvg, scale: number, type: "image/png" | "image/jpeg", fallbackBg = "#ffffff"): Promise<{ blob: Blob; width: number; height: number }> {
    const url = URL.createObjectURL(new Blob([doc.svg], { type: "image/svg+xml;charset=utf-8" }));
    try {
        const img = new Image();
        img.decoding = "sync";
        img.src = url;
        await img.decode();
        const width = Math.max(1, Math.round(doc.width * scale));
        const height = Math.max(1, Math.round(doc.height * scale));
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d");
        if (!ctx) throw new Error("Canvas is not available");
        if (type === "image/jpeg") {
            // JPEG has no alpha: paint the background first.
            ctx.fillStyle = doc.background ?? fallbackBg;
            ctx.fillRect(0, 0, width, height);
        }
        ctx.drawImage(img, 0, 0, width, height);
        const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, 0.95));
        if (!blob) throw new Error("Could not encode the image");
        return { blob, width, height };
    } finally {
        URL.revokeObjectURL(url);
    }
}

/**
 * Minimal single-page PDF containing one JPEG image scaled to `pageW × pageH`
 * points. No dependency; works on mobile.
 */
export function jpegToPdf(jpeg: Uint8Array, pxW: number, pxH: number, pageW: number, pageH: number): Uint8Array {
    const enc = new TextEncoder();
    const parts: Uint8Array[] = [];
    const offsets: number[] = [];
    let length = 0;
    const push = (chunk: Uint8Array | string) => {
        const bytes = typeof chunk === "string" ? enc.encode(chunk) : chunk;
        parts.push(bytes);
        length += bytes.length;
    };
    const obj = (n: number, body: string) => {
        offsets[n] = length;
        push(`${n} 0 obj\n${body}\nendobj\n`);
    };
    const w = pageW.toFixed(2);
    const h = pageH.toFixed(2);
    const content = `q ${w} 0 0 ${h} 0 0 cm /Im0 Do Q`;

    push("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n");
    obj(1, "<< /Type /Catalog /Pages 2 0 R >>");
    obj(2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>");
    obj(3, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>`);
    offsets[4] = length;
    push(`4 0 obj\n<< /Type /XObject /Subtype /Image /Width ${pxW} /Height ${pxH} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`);
    push(jpeg);
    push("\nendstream\nendobj\n");
    obj(5, `<< /Length ${content.length} >>\nstream\n${content}\nendstream`);

    const xref = length;
    let table = `xref\n0 6\n0000000000 65535 f \n`;
    for (let i = 1; i <= 5; i++) table += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
    push(table);
    push(`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);

    const out = new Uint8Array(length);
    let pos = 0;
    for (const p of parts) {
        out.set(p, pos);
        pos += p.length;
    }
    return out;
}

/** Raster PDF (any platform). */
export async function rasterPdf(doc: ExportedSvg, scale: number): Promise<Uint8Array> {
    const { blob, width, height } = await rasterize(doc, scale, "image/jpeg");
    const jpeg = new Uint8Array(await blob.arrayBuffer());
    // 1 CSS px = 0.75 pt
    return jpegToPdf(jpeg, width, height, doc.width * 0.75, doc.height * 0.75);
}

interface ElectronRemote {
    BrowserWindow: new (opts: Record<string, unknown>) => {
        loadURL(url: string): Promise<void>;
        webContents: { printToPDF(opts: Record<string, unknown>): Promise<Uint8Array> };
        destroy(): void;
    };
}

function electronRemote(): ElectronRemote | null {
    try {
        const req = (window as unknown as { require?: (m: string) => unknown }).require;
        const electron = req?.("electron") as { remote?: ElectronRemote } | undefined;
        if (electron?.remote?.BrowserWindow) return electron.remote;
        const remote = req?.("@electron/remote") as ElectronRemote | undefined;
        return remote?.BrowserWindow ? remote : null;
    } catch {
        return null;
    }
}

/** Vector PDF through Electron's print engine (desktop only); null when unavailable. */
export async function vectorPdf(doc: ExportedSvg): Promise<Uint8Array | null> {
    const remote = electronRemote();
    if (!remote) return null;
    const win = new remote.BrowserWindow({ show: false, webPreferences: { javascript: false } });
    try {
        const html =
            `<!doctype html><html><head><meta charset="utf-8"><style>` +
            `@page{size:${doc.width}px ${doc.height}px;margin:0}html,body{margin:0;padding:0}` +
            `body{background:${doc.background ?? "transparent"}}svg{display:block}` +
            `</style></head><body>${doc.svg}</body></html>`;
        await win.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(html));
        const data = await win.webContents.printToPDF({
            printBackground: true,
            preferCSSPageSize: true,
            margins: { marginType: "none" },
        });
        return new Uint8Array(data);
    } catch (e) {
        console.warn("[better-mindmap] vector PDF failed, falling back to raster", e);
        return null;
    } finally {
        win.destroy();
    }
}
