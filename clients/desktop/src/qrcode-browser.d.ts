declare module "qrcode/lib/browser.js" {
  interface SvgOptions {
    type: "svg";
    errorCorrectionLevel: "L" | "M" | "Q" | "H";
    margin: number;
    width: number;
    color: { dark: string; light: string };
  }

  const QRCode: {
    toString(text: string, options: SvgOptions): Promise<string>;
  };

  export default QRCode;
}
