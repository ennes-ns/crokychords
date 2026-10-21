"""The open models (docs/specs/moderation-v1.md §1, rules 6-15), loaded lazily and cached on disk:
faster-whisper (ASR) with its bundled silero VAD, and YAMNet (AudioSet events) as TFLite. They run
on the CPU of the machine running the job; no audio leaves it."""

from __future__ import annotations

import csv
import hashlib
import os
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np

from .audio import MODEL_RATE

# Both models expect 16 kHz mono.
assert MODEL_RATE == 16_000

YAMNET_WINDOW = 15_600  # 0.975 s at 16 kHz, the TFLite model's fixed input
YAMNET_HOP = 7_680  # 0.48 s, as the reference implementation


def cache_dir() -> Path:
    root = os.environ.get("MODERATION_CACHE") or str(Path.home() / ".cache" / "crokychords-moderation")
    path = Path(root)
    path.mkdir(parents=True, exist_ok=True)
    return path


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def fetch_checked(url: str, sha256: str, target: Path) -> Path:
    """Download ``url`` to ``target`` once; refuse a file whose checksum differs."""
    if target.exists() and sha256_file(target) == sha256:
        return target
    tmp = target.with_suffix(target.suffix + ".part")
    with urllib.request.urlopen(url, timeout=120) as response, tmp.open("wb") as out:  # noqa: S310
        while chunk := response.read(1 << 20):
            out.write(chunk)
    actual = sha256_file(tmp)
    if actual != sha256:
        tmp.unlink(missing_ok=True)
        raise RuntimeError(f"checksum mismatch for {url}: {actual}")
    tmp.replace(target)
    return target


@dataclass
class SpeechResult:
    transcript: str
    vad_ratio: float


class SpeechModel:
    """faster-whisper plus the silero VAD it bundles (ONNX)."""

    def __init__(self, config: dict[str, Any]) -> None:
        from faster_whisper import WhisperModel

        self.size = str(config["asr"]["size"])
        self.compute_type = str(config["asr"]["compute_type"])
        self.model = WhisperModel(
            self.size,
            device="cpu",
            compute_type=self.compute_type,
            download_root=str(cache_dir() / "whisper"),
        )

    def versions(self) -> dict[str, str]:
        import faster_whisper

        return {
            "asr": f"faster-whisper {faster_whisper.__version__} whisper-{self.size} {self.compute_type}",
            "vad": f"silero-vad (faster-whisper {faster_whisper.__version__})",
        }

    def vad_ratio(self, audio: np.ndarray) -> float:
        from faster_whisper.vad import VadOptions, get_speech_timestamps

        if audio.size == 0:
            return 0.0
        spans = get_speech_timestamps(audio, VadOptions(min_silence_duration_ms=200))
        speech = sum(int(s["end"]) - int(s["start"]) for s in spans)
        return min(1.0, speech / audio.size)

    def transcribe(self, audio: np.ndarray, max_no_speech_prob: float, min_word_probability: float) -> str:
        """The words Whisper is reasonably sure of: segments that are probably not speech and
        single words below ``min_word_probability`` are dropped (short clips make Whisper invent
        a word or two at the start)."""
        if audio.size == 0:
            return ""
        segments, _info = self.model.transcribe(
            audio,
            beam_size=5,
            vad_filter=True,
            condition_on_previous_text=False,
            word_timestamps=True,
        )
        kept: list[str] = []
        for segment in segments:
            if segment.no_speech_prob > max_no_speech_prob:
                continue
            for word in segment.words or []:
                if word.probability >= min_word_probability and word.word.strip():
                    kept.append(word.word.strip())
        return " ".join(kept)

    def analyse(self, audio: np.ndarray, max_no_speech_prob: float, min_word_probability: float) -> SpeechResult:
        return SpeechResult(
            transcript=self.transcribe(audio, max_no_speech_prob, min_word_probability),
            vad_ratio=self.vad_ratio(audio),
        )


class EventModel:
    """YAMNet (AudioSet, 521 classes) as TFLite."""

    def __init__(self, config: dict[str, Any]) -> None:
        from ai_edge_litert.interpreter import Interpreter

        events = config["events"]
        folder = cache_dir() / "yamnet"
        folder.mkdir(parents=True, exist_ok=True)
        self.model_sha = str(events["sha256"])
        model_path = fetch_checked(str(events["url"]), self.model_sha, folder / "yamnet.tflite")
        map_path = fetch_checked(
            str(events["class_map_url"]), str(events["class_map_sha256"]), folder / "yamnet_class_map.csv"
        )
        with map_path.open(encoding="utf-8") as f:
            self.classes = [row["display_name"] for row in csv.DictReader(f)]
        self.interpreter = Interpreter(model_path=str(model_path), num_threads=os.cpu_count() or 2)
        self.interpreter.allocate_tensors()
        self.input = self.interpreter.get_input_details()[0]["index"]
        self.output = self.interpreter.get_output_details()[0]["index"]

    def versions(self) -> dict[str, str]:
        return {"events": f"yamnet tflite sha256:{self.model_sha[:12]}"}

    def frames(self, audio: np.ndarray) -> list[np.ndarray]:
        if audio.size <= YAMNET_WINDOW:
            return [np.pad(audio, (0, YAMNET_WINDOW - audio.size))]
        starts = range(0, audio.size - YAMNET_WINDOW + YAMNET_HOP, YAMNET_HOP)
        out = []
        for start in starts:
            frame = audio[start : start + YAMNET_WINDOW]
            out.append(np.pad(frame, (0, YAMNET_WINDOW - frame.size)))
        return out

    def scores(self, audio: np.ndarray) -> dict[str, float]:
        """Max score per class over all frames (16 kHz mono input)."""
        best = np.zeros(len(self.classes), dtype=np.float32)
        for frame in self.frames(np.clip(audio, -1.0, 1.0).astype(np.float32)):
            self.interpreter.set_tensor(self.input, frame)
            self.interpreter.invoke()
            best = np.maximum(best, self.interpreter.get_tensor(self.output)[0])
        return {name: float(best[i]) for i, name in enumerate(self.classes)}

