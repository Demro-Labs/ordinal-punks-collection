import { useMemo } from "react";
import qrCodeFactory from "@/lib/qrcode-generator";

type QrCodeInstance = {
  addData(value: string): void;
  make(): void;
  createSvgTag(cellSize?: number, margin?: number): string;
};
type QrCodeFactory = (typeNumber: number, errorCorrectionLevel: "L" | "M" | "Q" | "H") => QrCodeInstance;

type LocalQrCodeProps = { value: string; alt: string; size?: number };

export function LocalQrCode({ value, alt, size = 180 }: LocalQrCodeProps) {
  const src = useMemo(() => {
    if (!value.trim()) return null;
    try {
      const createQr = qrCodeFactory as unknown as QrCodeFactory;
      const code = createQr(0, "M");
      code.addData(value);
      code.make();
      const svg = code.createSvgTag(4, 12);
      return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
    } catch {
      return null;
    }
  }, [value]);

  if (!src) {
    return <div role="status" className="mx-auto flex min-h-[180px] w-[180px] items-center justify-center rounded-lg border border-red-300 bg-white p-3 text-center text-xs text-red-700">QR indisponible. Copiez l’adresse affichée et vérifiez-la avant tout envoi.</div>;
  }

  return <img src={src} alt={alt} width={size} height={size} loading="eager" decoding="sync" className="mx-auto rounded-lg bg-white" style={{ width: size, height: size, imageRendering: "pixelated" }} />;
}
