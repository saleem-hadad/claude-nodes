// Records the microphone for a spoken prompt, with live levels for the meter.

export interface Recording {
  /** How loud a few bands of the voice range are right now, 0–1, low to high. */
  levels(): number[]
  /** Stops and resolves with the audio. */
  stop(): Promise<Blob>
  /** Stops and throws the audio away. */
  cancel(): void
}

export const BANDS = 5
/** The meter covers roughly where speech is, 100 Hz to 3 kHz. */
const LOW_HZ = 100
const HIGH_HZ = 3000

export async function startRecording(): Promise<Recording> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
  })
  const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : ''
  const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined)
  const chunks: Blob[] = []
  recorder.ondataavailable = (e) => {
    if (e.data.size) chunks.push(e.data)
  }
  recorder.start()

  const ctx = new AudioContext()
  const analyser = ctx.createAnalyser()
  analyser.fftSize = 256
  analyser.smoothingTimeConstant = 0.7
  ctx.createMediaStreamSource(stream).connect(analyser)
  const bins = new Uint8Array(analyser.frequencyBinCount)
  const hz = ctx.sampleRate / analyser.fftSize
  const lo = Math.max(1, Math.floor(LOW_HZ / hz))
  const hi = Math.min(bins.length, Math.ceil(HIGH_HZ / hz))
  const per = (hi - lo) / BANDS

  const release = () => {
    for (const track of stream.getTracks()) track.stop()
    void ctx.close()
  }

  return {
    levels() {
      analyser.getByteFrequencyData(bins)
      return Array.from({ length: BANDS }, (_, band) => {
        const from = Math.floor(lo + band * per)
        const to = Math.max(from + 1, Math.floor(lo + (band + 1) * per))
        let sum = 0
        for (let i = from; i < to; i++) sum += bins[i]
        return sum / (to - from) / 255
      })
    },
    stop: () =>
      new Promise((resolve) => {
        recorder.onstop = () => {
          release()
          resolve(new Blob(chunks, { type: recorder.mimeType }))
        }
        recorder.stop()
      }),
    cancel() {
      recorder.onstop = null
      if (recorder.state !== 'inactive') recorder.stop()
      release()
    }
  }
}
