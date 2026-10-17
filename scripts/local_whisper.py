#!/usr/bin/env python3
"""
scripts/local_whisper.py — High-Accuracy Local Multilingual (Hindi/Hinglish/English) STT.
Uses faster-whisper on CPU with INT8 quantization (~150MB RAM, zero network, zero tokens).

Usage:
  python3 scripts/local_whisper.py --audio /path/to/audio.wav [--model tiny|base] [--lang hi|en|auto]
"""

import sys
import os
import argparse
import json

def transcribe(audio_path, model_size="base", language="hi"):
    try:
        from faster_whisper import WhisperModel
    except ImportError:
        print(json.dumps({"error": "faster_whisper not installed in this python environment"}))
        sys.exit(1)

    if not os.path.exists(audio_path):
        print(json.dumps({"error": f"Audio file not found: {audio_path}"}))
        sys.exit(2)

    try:
        model = WhisperModel(model_size, device="cpu", compute_type="int8")
        lang = None if language == "auto" else language
        segments, info = model.transcribe(
            audio_path,
            beam_size=5,
            language=lang,
            task="transcribe",
            vad_filter=True,
            vad_parameters=dict(min_silence_duration_ms=500)
        )
        
        text_parts = [segment.text.strip() for segment in segments]
        full_text = " ".join(text_parts).strip()
        
        print(json.dumps({
            "ok": True,
            "text": full_text,
            "language": info.language,
            "language_probability": round(info.language_probability, 3),
            "duration": round(info.duration, 2)
        }))
    except Exception as e:
        print(json.dumps({"ok": False, "error": str(e)}))
        sys.exit(3)

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Local Whisper STT")
    parser.add_argument("--audio", required=True, help="Path to audio file (wav, mp3, webm, ogg, etc.)")
    parser.add_argument("--model", default="base", help="Model size: tiny, base, small (default: base)")
    parser.add_argument("--lang", default="auto", help="Language code: hi, en, auto (default: auto)")
    args = parser.parse_args()
    
    transcribe(args.audio, model_size=args.model, language=args.lang)
