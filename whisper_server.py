"""
Faster Whisper STT microservice — port 3003
No API key needed. Runs entirely locally.

Model: large-v3 (default) — best accuracy for EN+AR mixed speech with heavy accents.
       Set WHISPER_MODEL env var to override (tiny|base|small|medium|large-v3).
       large-v3 is ~3 GB but handles code-switching and accents far better than smaller models.
       Speed is not a concern — sessions are analysed offline after the student is done.

Endpoints:
  POST /transcribe   multipart: audio=<file>, prompt=<optional vocabulary hint>
  GET  /health       returns {"ok": true}

Start:
  pip install faster-whisper flask
  python3 whisper_server.py
"""

import os
import io
import time
import logging
import tempfile
from pathlib import Path

from flask import Flask, request, jsonify
from faster_whisper import WhisperModel

logging.basicConfig(level=logging.INFO, format="%(asctime)s [whisper] %(message)s")
log = logging.getLogger(__name__)

app = Flask(__name__)

MODEL_NAME = os.environ.get("WHISPER_MODEL", "large-v3")
PORT       = int(os.environ.get("WHISPER_PORT", 3003))

log.info(f"Loading Faster Whisper model '{MODEL_NAME}' on CPU (int8) …")
t0 = time.time()

# cpu / int8 — good accuracy, no GPU needed, reasonable RAM (~2-4 GB for large-v3)
model = WhisperModel(MODEL_NAME, device="cpu", compute_type="int8")

log.info(f"Model loaded in {time.time() - t0:.1f}s")


@app.get("/health")
def health():
    return jsonify({"ok": True, "model": MODEL_NAME})


@app.post("/transcribe")
def transcribe():
    """
    Accepts multipart/form-data:
      audio    — audio file (webm, mp4, wav, ogg, etc.)
      prompt   — optional vocabulary hint (e.g. first 200 chars of the submission text)
                 Biases Whisper toward domain-specific terms and correct spellings.
      language — optional ISO-639-1 code (e.g. "en", "ar").
                 Leave UNSET for auto-detection — handles EN/AR code-switching correctly.

    Returns JSON:
      { "transcript": "...", "language": "en", "confidence": 0.93, "duration": 12.4 }
    """
    if "audio" not in request.files:
        return jsonify({"error": "audio file required (multipart field: audio)"}), 400

    audio_file = request.files["audio"]
    prompt     = request.form.get("prompt", "")
    language   = request.form.get("language") or None  # None → auto-detect

    # Write to a temp file — faster-whisper needs a path, not a stream
    suffix = Path(audio_file.filename or "recording.webm").suffix or ".webm"
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
        tmp_path = tmp.name
        audio_file.save(tmp_path)

    try:
        t0 = time.time()

        segments, info = model.transcribe(
            tmp_path,
            language=language,       # None = auto-detect per segment
            initial_prompt=prompt or None,
            vad_filter=True,         # skip silence — reduces hallucinations on quiet segments
            vad_parameters={
                "min_silence_duration_ms": 500,
                "threshold": 0.4,
            },
            beam_size=5,             # higher than default (1) → better accuracy at the cost of speed
            best_of=5,               # candidates considered per timestep
            temperature=0.0,         # greedy decode → deterministic, reduces hallucination
            word_timestamps=False,
        )

        # Collect all segment texts
        full_transcript = " ".join(seg.text.strip() for seg in segments).strip()
        duration        = time.time() - t0

        # Compute average log-prob as a confidence proxy (Faster Whisper exposes avg_logprob per segment)
        # Re-transcribe with segment info to get confidence
        segments2, info2 = model.transcribe(
            tmp_path,
            language=language,
            initial_prompt=prompt or None,
            vad_filter=True,
            beam_size=5,
            best_of=5,
            temperature=0.0,
        )
        seg_list = list(segments2)
        if seg_list:
            avg_logprob = sum(s.avg_logprob for s in seg_list) / len(seg_list)
            # Convert log-prob to a 0-1 confidence: logprob of 0 = 100%, -1 ≈ 37%
            import math
            confidence = round(math.exp(avg_logprob), 3)
        else:
            confidence = 0.0

        log.info(
            f"Transcribed {info2.duration:.1f}s audio in {duration:.1f}s | "
            f"lang={info2.language} conf={confidence:.2f} | '{full_transcript[:80]}'"
        )

        return jsonify({
            "transcript": full_transcript,
            "language":   info2.language,
            "confidence": confidence,
            "duration":   round(info2.duration, 2),
        })

    finally:
        os.unlink(tmp_path)


if __name__ == "__main__":
    log.info(f"Faster Whisper STT server starting on port {PORT}")
    # threaded=False — large-v3 on CPU is not thread-safe; process requests one at a time.
    # This is fine: sessions are analyzed sequentially after the student is done.
    app.run(host="0.0.0.0", port=PORT, threaded=False)
