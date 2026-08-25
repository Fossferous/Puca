# Voice Settings Documentation

## Overview

Púca uses WebRTC (Web Real-Time Communication) for voice chat. WebRTC is the same technology used by many mainstream chat and video-call apps (e.g. Google Meet, Zoom) for browser-based audio/video calls. This document explains the voice processing features available in Settings → Voice & Video.

---

## Noise Suppression

### What It Is
Noise suppression is a **real-time audio filter** that removes unwanted background sounds from your microphone input before transmitting to other users.

### Modes (Settings → Voice → Voice Processing → Noise Suppression Mode)
One setting, two pickers (this one and the dropdown in the voice panel), applied live mid-call:
- **No suppression** — the raw mic.
- **Standard** — the browser's built-in filter described below (the "Browser Noise Suppression" checkbox turns it on/off in this mode only).
- **RNNoise (ML)** — a small neural model in an audio worklet; better on keyboards, fans and background voices, ~10 ms of delay.
- **DeepFilter (Max)** — the heaviest model (DeepFilterNet 3), best quality, real CPU cost, ~60 ms of delay; shown after enabling it under Advanced → Experimental. Falls back to RNNoise if it cannot start or keep up.

Use the **Mic Test** below to hear a take through each mode.

### How It Works (Technical Details)

WebRTC's noise suppression uses a **machine learning-based algorithm** (specifically, a Recurrent Neural Network or RNN) that runs directly in your browser. Here's the process:

1. **Audio Capture**: Your microphone captures raw audio at typically 48kHz sample rate
2. **Frame Analysis**: Audio is split into small frames (typically 10-20ms each)
3. **Feature Extraction**: The algorithm analyzes each frame to extract characteristics:
   - Frequency spectrum (which pitches are present)
   - Temporal patterns (how sounds change over time)
   - Energy levels (loudness)
4. **Classification**: The neural network classifies each frequency component as either:
   - **Speech** - Human voice frequencies (typically 85Hz - 8kHz)
   - **Noise** - Background sounds (fans, AC, traffic, keyboard clicks, etc.)
5. **Suppression**: Noise-classified frequencies are attenuated (reduced in volume) while speech frequencies are preserved
6. **Reconstruction**: The cleaned audio is reconstructed and transmitted

### What Gets Filtered
- ✅ Constant background noise (fans, HVAC, humming)
- ✅ Keyboard and mouse clicks
- ✅ Ambient room noise
- ✅ Light traffic sounds
- ⚠️ Sudden loud noises (partially filtered, may still come through briefly)
- ❌ Music or other speech (intentionally NOT filtered - treated as desired audio)

### Performance Notes
- Runs entirely in your browser (no cloud processing)
- Typical latency: 10-30ms (imperceptible)
- CPU usage: Minimal on modern devices
- Works best with consistent background noise

---

## Echo Cancellation

### What It Is
Echo cancellation prevents **acoustic feedback loops** where sound from your speakers gets picked up by your microphone and transmitted back to other users.

### How It Works

1. **Reference Signal**: The system knows what audio is playing through your speakers
2. **Microphone Capture**: Your mic captures both your voice AND speaker output that's bouncing around the room
3. **Subtraction**: The algorithm "subtracts" the known speaker output from the mic input
4. **Residual Voice**: What remains is (mostly) just your voice

### When To Use It
- ✅ **Always enable** if using speakers instead of headphones
- ✅ Recommended even with headphones (sound can leak)
- ❌ May disable if using high-quality isolating headphones and experiencing audio issues

---

## Auto Gain Control (AGC)

### What It Is
AGC automatically adjusts your microphone's amplification level to maintain consistent volume.

### How It Works

1. **Level Monitoring**: Continuously measures your audio input level
2. **Target Level**: Compares against an ideal target volume
3. **Automatic Adjustment**:
   - **Speaking quietly?** → Increases gain (amplification)
   - **Speaking loudly?** → Decreases gain
   - **Silent?** → Gradually returns to baseline
4. **Response Time**: Adjustments happen over 100-500ms to avoid pumping effects

### When To Disable AGC (Use Manual Gain Instead)

- **Streaming/Recording**: AGC can cause volume fluctuations
- **Quiet environment**: AGC may boost room noise during pauses
- **Professional microphone**: Pre-amps often have their own gain control
- **Consistent speaking volume**: Manual gain gives more predictable results

### Manual Gain (0-200%)
When AGC is disabled, you can manually set your microphone gain:
- **0%**: No amplification (very quiet)
- **100%**: Normal level
- **200%**: 2x amplification (for quiet mics)

Use the **Mic Test** feature to adjust while watching the level meter.

---

## Input/Output Volume

### Input Volume (0-200%)
This is a **software gain control** that amplifies your microphone signal after all processing:
- Applied AFTER noise suppression, echo cancellation, and AGC
- Values over 100% can cause clipping (distortion) if your mic is already loud
- Use in combination with Manual Gain when AGC is disabled

### Output Volume (0-100%)
Controls how loud other people's voices are to you:
- Does NOT affect your voice to others
- 100% = full system volume (respects OS volume settings)
- Reduces the volume of all incoming voice chat audio

---

## Device Selection

### Why Devices Show as "Default" or Numbers
Browsers protect user privacy by not exposing device names until microphone permission is granted. Once you access Voice & Video settings, Púca requests permission and device names become visible.

### Choosing the Right Device
- **Default**: Uses your system's default device (follows OS settings)
- **Specific Device**: Locks to that device even if system default changes

---

## Mic Test Feature

### Record, then loop through your settings (0.8.96)
The mic test works like a studio mic check with live processing: it
**records a short raw take and loops it back through the settings you have
selected** — there is no live monitoring, so nothing feeds back and you do not
need headphones.

1. **Record 6 s** captures your selected input device raw. A countdown and an
   input level meter run while you speak; it stops by itself, or press
   **Stop** early to keep what you have (takes under half a second are
   discarded).
2. The mic is released and the take **starts looping** on your output device
   at your Output Volume, processed through the selected **Noise Suppression
   Mode** and your **Input Volume / Manual Gain** — the line under it names the
   mode. **Stop** / **Play** control the loop; **Record again** replaces the
   take.
3. **Change the mode, the DeepFilter post filter, or Input Volume while it
   loops** and the same take changes with them — that is how to compare modes.
   The loop never stops when a mode changes; the processing swaps under it
   ("Setting up X…" for a moment on DeepFilter's first use).
4. Echo cancellation, auto gain and the browser's own noise suppression are
   applied *inside* the microphone capture, so they are baked into the take:
   the line under it says what it was captured with — record again to hear
   those change.
5. Leaving the Voice section (for example to enable DeepFilter under
   Advanced → Experimental) stops the loop but keeps the take; closing
   Settings drops it.

### Using the Level Meter
- 🟢 **Green (0-33%)**: Too quiet, increase gain
- 🟡 **Yellow (33-66%)**: Good range for speech
- 🔴 **Red (66-100%)**: Loud, may clip - decrease gain

### Ideal Settings
1. Disable AGC for testing
2. Start with Manual Gain at 100%
3. Speak at normal volume
4. Adjust until peaks hit yellow zone
5. Re-enable AGC if desired (it will use your baseline)

---

## Browser Compatibility

| Feature | Chrome | Firefox | Safari | Edge |
|---------|--------|---------|--------|------|
| Noise Suppression | ✅ | ✅ | ⚠️ Limited | ✅ |
| Echo Cancellation | ✅ | ✅ | ✅ | ✅ |
| Auto Gain Control | ✅ | ✅ | ⚠️ Limited | ✅ |
| Device Selection | ✅ | ✅ | ✅ | ✅ |

**Note**: Safari's WebRTC implementation may have reduced noise suppression quality.

---

## Troubleshooting

### "No microphone access"
- Check browser permissions (lock icon in URL bar)
- Ensure mic isn't being used by another app
- Try "Default" device instead of specific device

### Audio sounds robotic/choppy
- Disable noise suppression temporarily
- Check your internet connection
- Try a different browser

### Others say I'm too quiet
1. Increase Input Volume
2. Disable AGC and increase Manual Gain
3. Check if mic is positioned correctly

### Others hear echo
- Enable Echo Cancellation
- Use headphones instead of speakers
- Reduce speaker volume
