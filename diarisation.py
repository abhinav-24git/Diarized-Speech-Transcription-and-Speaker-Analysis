from pyannote.audio import Audio
from pyannote.core import Segment
import contextlib
import wave
import numpy as np
from sklearn.cluster import AgglomerativeClustering
from sklearn.metrics import silhouette_score
import datetime
import subprocess
import os
import time
from pyannote.audio.pipelines.speaker_verification import PretrainedSpeakerEmbedding
from groq_manager import GroqManager


class SpeakerDiarizer:
    def __init__(self, num_speakers=None):
        self.num_speakers = num_speakers
        # Global or local Groq Manager
        self.manager = GroqManager()
        self.embedding_model = PretrainedSpeakerEmbedding("speechbrain/spkrec-ecapa-voxceleb")

    def segment_embedding(self, segment, waveform, sample_rate, duration):
        start = segment["start"]
        end = min(duration, segment["end"])
        start_sample = int(start * sample_rate)
        end_sample = int(end * sample_rate)
        clip_waveform = waveform[:, start_sample:end_sample]
        return self.embedding_model(clip_waveform[None])

    def _transcribe_groq(self, audio_path):
        """Groq Whisper call using GroqManager rotation logic."""
        def _whisper_call(inner_client, inner_model):
            with open(audio_path, "rb") as f:
                return inner_client.audio.transcriptions.create(
                    file=(os.path.basename(audio_path), f.read()),
                    model=inner_model,
                    response_format="verbose_json",
                )

        # Note: We use model="whisper-large-v3" as primary. 
        # GroqManager will try it first, then fallback to same or different if we adjust it.
        return self.manager.execute_with_retry(_whisper_call, model="whisper-large-v3")

    def diarize(self, path, num_speakers=None):
        if num_speakers is None:
            num_speakers = self.num_speakers

        processed_audio_file = "temp_audio_pyannote.wav"
        groq_audio_file = "temp_audio_groq.mp3"

        try:
            # ------------------------------------------------------------------
            # STEP 1 — Single ffmpeg call: WAV for pyannote + MP3 for Groq
            #           One decode pass → two outputs (original proven approach)
            #           Start with 32k bitrate for Groq version
            # ------------------------------------------------------------------
            subprocess.call([
                'ffmpeg',
                '-i', path,
                '-ac', '1', '-ar', '16000',          # output 1: WAV for pyannote
                processed_audio_file,
                '-ac', '1', '-ar', '16000', '-b:a', '32k',  # output 2: MP3 for Groq
                groq_audio_file,
                '-y'
            ])

            # ------------------------------------------------------------------
            # STEP 2 — File-size guard for Groq's 25 MB limit
            #           If 32k is still too big (very long audio), recompress at 16k.
            # ------------------------------------------------------------------
            GROQ_MAX_BYTES = 24 * 1024 * 1024  # 24 MB safety margin
            if not os.path.exists(groq_audio_file):
                raise FileNotFoundError(f"FFmpeg failed to create {groq_audio_file}")
                
            groq_size = os.path.getsize(groq_audio_file)
            print(f"Groq MP3 size (32k): {groq_size / 1024 / 1024:.2f} MB")

            if groq_size > GROQ_MAX_BYTES:
                print("MP3 exceeds 24 MB — recompressing at 16k bitrate...")
                subprocess.call([
                    'ffmpeg', '-i', path,
                    '-ac', '1', '-ar', '16000', '-b:a', '16k',
                    groq_audio_file, '-y'
                ])
                groq_size = os.path.getsize(groq_audio_file)
                print(f"Groq MP3 size (16k): {groq_size / 1024 / 1024:.2f} MB")

            if groq_size > GROQ_MAX_BYTES:
                raise RuntimeError(
                    f"Audio file is too long to process even at 16k bitrate "
                    f"({groq_size / 1024 / 1024:.1f} MB). Please trim the audio to under ~8 hours."
                )

            # ------------------------------------------------------------------
            # STEP 3 — Transcription via Groq Whisper (with rotation/fallback)
            # ------------------------------------------------------------------
            transcription = self._transcribe_groq(groq_audio_file)

            segments = []
            for s in transcription.segments:
                s_dict = s if isinstance(s, dict) else getattr(s, '__dict__', {})
                if hasattr(s, 'model_dump'):
                    s_dict = s.model_dump()
                segments.append({
                    "start": float(s_dict.get("start", 0.0)),
                    "end":   float(s_dict.get("end",   0.0)),
                    "text":  str(s_dict.get("text",   ""))
                })

            # ------------------------------------------------------------------
            # STEP 4 — Speaker embeddings from the pyannote WAV
            # ------------------------------------------------------------------
            if not os.path.exists(processed_audio_file):
                raise FileNotFoundError(f"FFmpeg failed to create {processed_audio_file}")
                
            audio = Audio()
            full_waveform, sample_rate = audio(processed_audio_file)
            duration = full_waveform.shape[1] / float(sample_rate)

            embeddings = []
            for segment in segments:
                embeddings.append(self.segment_embedding(segment, full_waveform, sample_rate, duration))

            embeddings = np.nan_to_num(np.array(embeddings))
            embeddings = np.concatenate(embeddings, axis=0)
            num_embeddings = len(embeddings)
        finally:
            # Always clean up temporary files
            for f in [processed_audio_file, groq_audio_file]:
                if os.path.exists(f):
                    try:
                        os.remove(f)
                    except Exception as cleanup_err:
                        print(f"Cleanup error for {f}: {cleanup_err}")
            
        # ------------------------------------------------------------------
        # STEP 5 — Agglomerative clustering → speaker labels
        # ------------------------------------------------------------------
        if num_speakers is not None:
            try:
                clustering = AgglomerativeClustering(n_clusters=min(num_speakers, num_embeddings), metric="cosine", linkage="average")
            except TypeError:
                clustering = AgglomerativeClustering(n_clusters=min(num_speakers, num_embeddings), affinity="cosine", linkage="average")
            labels = clustering.fit_predict(embeddings)

        elif num_embeddings <= 1:
            labels = np.zeros(num_embeddings, dtype=int)

        else:
            # Auto-detect: try k=2..10 and pick highest silhouette score
            max_speakers = min(10, num_embeddings)
            best_num_speakers = 1
            best_score = -1
            best_labels = np.zeros(num_embeddings, dtype=int)

            for k in range(2, max_speakers + 1):
                try:
                    clustering = AgglomerativeClustering(n_clusters=k, metric="cosine", linkage="average")
                except TypeError:
                    clustering = AgglomerativeClustering(n_clusters=k, affinity="cosine", linkage="average")
                current_labels = clustering.fit_predict(embeddings)
                score = silhouette_score(embeddings, current_labels, metric="cosine")
                print(f"Testing {k} speakers... Silhouette Score: {score:.4f}")

                if score > best_score:
                    best_score = score
                    best_num_speakers = k
                    best_labels = current_labels

            if best_score < 0.05:
                print("Poor clustering scores — falling back to 1 speaker.")
                labels = np.zeros(num_embeddings, dtype=int)
            else:
                print(f"Optimal: {best_num_speakers} speakers (score={best_score:.4f})")
                labels = best_labels

        # ------------------------------------------------------------------
        # STEP 6 — Assign SPEAKER N labels + build transcript string
        # ------------------------------------------------------------------
        for i, segment in enumerate(segments):
            segment["speaker"] = f"SPEAKER {labels[i] + 1}"

        def time(secs):
            return datetime.timedelta(seconds=round(secs))

        transcript = ""
        for i, segment in enumerate(segments):
            if i == 0 or segments[i - 1]["speaker"] != segment["speaker"]:
                transcript += f"\n{segment['speaker']} {time(segment['start'])}\n"
            transcript += segment["text"].strip() + " "

        return transcript, segments