import jsQR from 'jsqr';

/** Browser-only QR scanning shared by the standalone demo and Vue applications. */

const FRAME_INTERVAL_MS = 150;
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;

function cameraError(error: unknown): Error {
  if (error instanceof DOMException && error.name === 'NotAllowedError') {
    return new Error('相机未获授权。请在浏览器中允许相机，或改用“导入二维码图片”。');
  }
  if (error instanceof DOMException && error.name === 'NotFoundError') {
    return new Error('没有找到可用的相机。请导入二维码图片，或使用配对文本。');
  }
  if (error instanceof DOMException && error.name === 'NotReadableError') {
    return new Error('相机可能正在被其他应用占用。关闭占用后重试，或导入二维码图片。');
  }
  return new Error('无法打开相机。请重试，或改用二维码图片、配对文本。');
}

export class QrScanner {
  private readonly canvas = document.createElement('canvas');
  private readonly context = this.canvas.getContext('2d', { willReadFrequently: true });
  private stream: MediaStream | null = null;
  private frame = 0;
  private generation = 0;
  private removeTrackListeners: (() => void)[] = [];

  constructor(private readonly video: HTMLVideoElement) {}

  async start(onResult: (value: string) => void, onError: (error: Error) => void): Promise<boolean> {
    this.stop();
    const generation = this.generation;
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      throw new Error('当前地址不能使用相机。请通过 HTTPS 或 localhost 打开，或导入二维码图片、粘贴配对文本。');
    }
    if (!this.context) throw new Error('浏览器无法读取扫码画面，请使用配对文本。');

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 960 } },
      });
      if (generation !== this.generation || document.hidden) {
        stream.getTracks().forEach((track) => track.stop());
        return false;
      }
      this.stream = stream;
      this.video.srcObject = stream;
      this.video.muted = true;
      this.video.playsInline = true;
      await this.video.play();
      if (generation !== this.generation || document.hidden) {
        stream.getTracks().forEach((track) => track.stop());
        return false;
      }
      for (const track of stream.getVideoTracks()) {
        const ended = () => {
          if (generation !== this.generation) return;
          this.stop();
          onError(new Error('相机已中断。请重新打开相机，或导入二维码图片。'));
        };
        track.addEventListener('ended', ended);
        this.removeTrackListeners.push(() => track.removeEventListener('ended', ended));
      }

      let lastFrame = -FRAME_INTERVAL_MS;
      const scan = (now: number) => {
        if (generation !== this.generation) return;
        try {
          if (now - lastFrame >= FRAME_INTERVAL_MS && this.video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
            lastFrame = now;
            const width = this.video.videoWidth;
            const height = this.video.videoHeight;
            if (width && height) {
              const scale = Math.min(1, 1280 / Math.max(width, height));
              this.canvas.width = Math.round(width * scale);
              this.canvas.height = Math.round(height * scale);
              this.context!.drawImage(this.video, 0, 0, this.canvas.width, this.canvas.height);
              const pixels = this.context!.getImageData(0, 0, this.canvas.width, this.canvas.height);
              const code = jsQR(pixels.data, pixels.width, pixels.height, { inversionAttempts: 'dontInvert' });
              if (code?.data) {
                this.stop();
                onResult(code.data);
                return;
              }
            }
          }
          this.frame = requestAnimationFrame(scan);
        } catch {
          this.stop();
          onError(new Error('无法读取相机画面。请重新打开相机，或导入二维码图片。'));
        }
      };
      this.frame = requestAnimationFrame(scan);
      return true;
    } catch (error) {
      if (generation !== this.generation) return false;
      this.stop();
      throw cameraError(error);
    }
  }

  stop(): void {
    this.generation += 1;
    cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.removeTrackListeners.forEach((remove) => remove());
    this.removeTrackListeners = [];
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
    this.video.pause();
    this.video.srcObject = null;
  }
}

export async function decodeQrImage(file: File): Promise<string> {
  if (!file.type.startsWith('image/')) throw new Error('请选择一张包含完整二维码的图片。');
  if (file.size > MAX_IMAGE_BYTES) throw new Error('图片超过 12 MB。请裁剪到二维码区域后重新导入。');
  const url = URL.createObjectURL(file);
  const image = new Image();
  try {
    image.src = url;
    try {
      await image.decode();
    } catch {
      throw new Error('无法读取这张图片。请使用 PNG 或 JPEG 格式的二维码图片。');
    }
    const canvas = document.createElement('canvas');
    const scale = Math.min(1, 2048 / Math.max(image.naturalWidth, image.naturalHeight));
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('浏览器无法读取图片，请使用配对文本。');
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
    const code = jsQR(pixels.data, pixels.width, pixels.height, { inversionAttempts: 'attemptBoth' });
    if (!code?.data) throw new Error('没有识别到二维码。请导入清晰、完整的原图，或使用配对文本。');
    return code.data;
  } finally {
    URL.revokeObjectURL(url);
  }
}
