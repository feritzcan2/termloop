/** Reduce native PCM to mono speech bandwidth before upload. Native capture
 * stays at the hardware rate because iOS's stream converter can return silence. */
export function voiceUploadPcm(chunks: readonly Uint8Array[], byteLength: number, sampleRate: number, channels: number) {
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  const input = new DataView(bytes.buffer);
  const frameCount = Math.floor(byteLength / (channels * 2));
  const mono = new Float32Array(frameCount);
  for (let frame = 0; frame < frameCount; frame += 1) {
    let sum = 0;
    for (let channel = 0; channel < channels; channel += 1) sum += input.getInt16((frame * channels + channel) * 2, true);
    mono[frame] = sum / channels;
  }
  // An integer stride keeps timing exact (48 kHz → 16 kHz; 44.1 kHz → 14.7 kHz).
  const stride = Math.max(1, Math.ceil(sampleRate / 16_000));
  const kernel = lowPassKernel(stride);
  const radius = (kernel.length - 1) / 2;
  const output = new Uint8Array(Math.ceil(frameCount / stride) * 2);
  const pcm = new DataView(output.buffer);
  for (let frame = 0; frame * stride < frameCount; frame += 1) {
    let sample = 0;
    for (let tap = 0; tap < kernel.length; tap += 1) {
      const source = Math.max(0, Math.min(frameCount - 1, frame * stride + tap - radius));
      sample += mono[source]! * kernel[tap]!;
    }
    pcm.setInt16(frame * 2, Math.max(-32_768, Math.min(32_767, Math.round(sample))), true);
  }
  return { bytes: output, sampleRate: sampleRate / stride, channels: 1 };
}

/** Windowed sinc suppresses frequencies above the new Nyquist limit so they
 * cannot fold back into the speech band when samples are discarded. */
function lowPassKernel(stride: number): number[] {
  if (stride === 1) return [1];
  const radius = 16 * stride;
  const cutoff = 0.45 / stride;
  const kernel = Array.from({ length: radius * 2 + 1 }, (_, index) => {
    const x = index - radius;
    const sinc = x === 0 ? 2 * cutoff : Math.sin(2 * Math.PI * cutoff * x) / (Math.PI * x);
    return sinc * (0.54 + 0.46 * Math.cos(Math.PI * x / radius));
  });
  const sum = kernel.reduce((total, value) => total + value, 0);
  return kernel.map((value) => value / sum);
}
