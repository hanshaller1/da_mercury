// 24-bit PCM WAV encoder

export function encodeWav(audioBuffer) {
  const ch = audioBuffer.numberOfChannels;
  const sr = audioBuffer.sampleRate;
  const n = audioBuffer.length;
  const bytesPerSample = 3;
  const dataSize = n * ch * bytesPerSample;
  const buf = new ArrayBuffer(44 + dataSize);
  const v = new DataView(buf);
  const str = (o, s) => {
    for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i));
  };
  str(0, 'RIFF');
  v.setUint32(4, 36 + dataSize, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, ch, true);
  v.setUint32(24, sr, true);
  v.setUint32(28, sr * ch * bytesPerSample, true);
  v.setUint16(32, ch * bytesPerSample, true);
  v.setUint16(34, 24, true);
  str(36, 'data');
  v.setUint32(40, dataSize, true);

  const chans = [];
  for (let c = 0; c < ch; c++) chans.push(audioBuffer.getChannelData(c));
  let o = 44;
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < ch; c++) {
      let s = Math.max(-1, Math.min(1, chans[c][i]));
      let x = Math.round(s * 8388607);
      if (x < 0) x += 16777216;
      v.setUint8(o, x & 0xff);
      v.setUint8(o + 1, (x >> 8) & 0xff);
      v.setUint8(o + 2, (x >> 16) & 0xff);
      o += 3;
    }
  }
  return new Blob([buf], { type: 'audio/wav' });
}

export function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
