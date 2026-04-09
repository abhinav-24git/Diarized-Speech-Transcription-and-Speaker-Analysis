from flask import Flask, render_template, request, jsonify
from werkzeug.utils import secure_filename
import os
import json
import logging
logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")

from diarisation import SpeakerDiarizer
from groq_manager import GroqManager
from metrics import compute_all_metrics, compute_final_scores, generate_explanations

# ---------------------------
# INIT
# ---------------------------

# Global Groq Manager
manager = GroqManager()
client = manager.get_client() # For backwards compatibility where simple client is needed

app = Flask(__name__)
app.config['MAX_CONTENT_LENGTH'] = 500 * 1024 * 1024  # 500 MB — allow large audio files
os.environ["PATH"] += os.pathsep + "C:\\ffmpeg\\bin" + os.pathsep + os.path.expandvars(r"%LOCALAPPDATA%\Microsoft\WinGet\Links")

UPLOAD_FOLDER = "uploads"
os.makedirs(UPLOAD_FOLDER, exist_ok=True)

ALLOWED_EXTENSIONS = {'wav', 'mp3', 'm4a'}
diarizer = SpeakerDiarizer()


# ---------------------------
# HELPERS
# ---------------------------

def allowed_file(filename):
    return '.' in filename and filename.rsplit('.', 1)[1].lower() in ALLOWED_EXTENSIONS


def transcribe_audio(audio_path, num_spk=None):
    # 🔥 IMPORTANT: now returns transcript + segments
    transcript, segments = diarizer.diarize(audio_path, num_speakers=num_spk)
    print(transcript)
    return transcript, segments


# ---------------------------
# LLM ANALYSIS (JSON OUTPUT)
# ---------------------------
def safe_truncate_transcript(text, max_chars=100000):
    """Approximate truncation to stay under TPM limits (mostly for 8B model)."""
    if len(text) > max_chars:
        logging.warning(f"Transcript is very long ({len(text)} chars). Truncating to {max_chars} chars for API safety.")
        # Keep the beginning and end, or just the first X chars. 
        # For analysis, the full context is good, but usually the most important points stay in the first 100k chars.
        return text[:max_chars] + "\n\n[TRANSCRIPT TRUNCATED FOR SIZE...]"
    return text

def analyze_with_llm(text, topic, metrics):
    text = safe_truncate_transcript(text)
    speaker_keys = list(metrics.keys())

    speaker_json_structure = ",\n".join([f'    "{sp}": {{\n      "contribution_quality": 0,\n      "interaction_score": 0,\n      "decision_impact": 0\n    }}' for sp in speaker_keys])

    def _call_analysis(inner_client, inner_model):
        return inner_client.chat.completions.create(
            model=inner_model,
            temperature=0.5,
            messages=[
                {
                    "role": "user",
                    "content": f"""
Return ONLY valid JSON. No explanation.

STRICT RULES:
- Use double quotes
- No extra text
- Do not leave fields empty
- Scores must be 0–10 integers

Context:
Meeting Topic: {topic}

Speaker Metrics:
{metrics}

Full Conversation Transcript:
{text}

ANALYSIS PROTOCOL (Follow these stages internally):
STAGE 1: Task Identification. Search the transcript for keywords like "to do," "action item," "assigned to," "deadline," "I will," or "next steps." List these as Action Items.
STAGE 2: Decision Impact Analysis. Compare the "Intent" (found in the first 10% of the conversation) with the "Decisions" (found in the final 20%). Determine if the original goal was achieved and identify the specific "Delta" or change in status.

Return BOTH:

1. High-level analysis (Professional, descriptive narrative)
2. Speaker evaluation

JSON format:
{{
  "summary": "Descriptive, narrative summary of the entire discussion. Avoid dry lists.",
  "intent": "What was the explicit goal at the start?",
  "action_items": "Specific task-oriented bullet points based on Stage 1.",
  "decision_impact": "How did the meeting end vs how it started? Use Stage 2 insights.",

  "speaker_scores": {{
{speaker_json_structure}
  }}
}}
"""
                }
            ]
        ).choices[0].message.content.strip()

    raw_output = manager.execute_with_retry(_call_analysis)
    print("\n=== RAW LLM OUTPUT ===\n", raw_output, "\n====================\n")

    def _extract_json(text):
        """Robustly extract a JSON object from raw LLM text."""
        import re
        # Step 1: Strip markdown code fences (```json ... ``` or ``` ... ```)
        text = re.sub(r'^```[a-zA-Z]*\n?', '', text.strip())
        text = re.sub(r'\n?```$', '', text.strip())
        text = text.strip()

        # Step 2: Direct parse
        try:
            return json.loads(text)
        except Exception:
            pass

        # Step 3: Try fixing single quotes
        try:
            return json.loads(text.replace("'", '"'))
        except Exception:
            pass

        # Step 4: Extract the largest {...} block via regex
        try:
            match = re.search(r'\{[\s\S]*\}', text)
            if match:
                return json.loads(match.group())
        except Exception:
            pass

        return None

    parsed = _extract_json(raw_output)
    if not parsed:
        parsed = {
            "summary": "Analysis could not be parsed. Please retry.",
            "intent": "-",
            "action_items": "-",
            "decision_impact": "-",
            "speaker_scores": {}
        }

    return parsed


# ---------------------------
# LLM SPEAKER NAME IDENTIFICATION
# ---------------------------
def identify_speaker_names(segments, speaker_ids):
    """
    Uses LLM to infer real names OR roles for each generic SPEAKER N label.
    Scans full transcript but weights the first 120 seconds (introductions) higher.
    """
    # Create the 'Priority Intro' (first 2 mins) and the 'General Context'
    intro_lines = []
    general_lines = []
    
    for seg in segments:
        line = f"{seg['speaker']}: {seg['text']}"
        if seg['start'] < 120:  # First 120 seconds
            intro_lines.append(line)
        general_lines.append(line)

    intro_context = "\n".join(intro_lines)
    full_context = safe_truncate_transcript("\n".join(general_lines), max_chars=80000)
    
    speaker_list_str = ", ".join(speaker_ids)

    def _call_id(inner_client, inner_model):
        return inner_client.chat.completions.create(
            model=inner_model,
            messages=[
                {
                    "role": "user",
                    "content": f"""Identify the most meaningful label for each speaker.
                    
Speakers to identify: {speaker_list_str}

SECTION 1: HIGH PRIORITY (First 2 minutes - Look for introductions here)
{intro_context}

SECTION 2: FULL CONTEXT (Clues mentioned throughout the meeting)
{full_context}

IDENTIFICATION RULES:
1. PRIORITY 1: Real Names. Look closely at SECTION 1 for "My name is..." or "I am...".
2. PRIORITY 2: Role/Job Title. If no name is found, look across both sections for role clues (e.g., "As the manager...", "Thanks for interviewing me").
3. PRIORITY 3: "Unknown" (Only if absolutely no clues exist).

OUTPUT RULES:
- Return ONLY valid JSON, no explanation, no markdown
- Every speaker label must appear as a key
- Values must be either: a real name, a role title, or exactly "Unknown"
- Do NOT repeat the same label for two different speakers unless they truly share the same unnamed role

Expected format:
{{
  "SPEAKER 1": "Abhilash",
  "SPEAKER 2": "Interviewer"
}}
"""
                }
            ]
        ).choices[0].message.content.strip()

    raw = manager.execute_with_retry(_call_id)
    logging.info(f"Speaker name LLM raw output: {raw}")

    def _extract_json(text):
        import re
        text = re.sub(r'^```[a-zA-Z]*\n?', '', text.strip())
        text = re.sub(r'\n?```$', '', text.strip()).strip()
        try:
            return json.loads(text)
        except Exception:
            pass
        try:
            return json.loads(text.replace("'", '"'))
        except Exception:
            pass
        try:
            match = re.search(r'\{[\s\S]*\}', text)
            if match:
                return json.loads(match.group())
        except Exception:
            pass
        return None

    name_map = _extract_json(raw)
    if not name_map:
        name_map = {sp: sp for sp in speaker_ids}

    # Ensure all speaker IDs are present; default to original label if missing
    for sp in speaker_ids:
        if sp not in name_map or not str(name_map[sp]).strip():
            name_map[sp] = sp

    return name_map


def apply_speaker_names(name_map, segments, transcript, metrics, analysis, final_scores, explanations):
    """
    Remaps all data structures using the resolved name_map.
    - Real names and role labels are applied.
    - Multiple speakers with the same role get numbered: Interviewer 1, Interviewer 2...
    - Only literal "Unknown" keeps the original SPEAKER N label.
    """
    # --- Step 1: Replace "Unknown" with original speaker label ---
    resolved = {}
    for sp, name in name_map.items():
        if name and str(name).strip().lower() != "unknown":
            resolved[sp] = str(name).strip()
        else:
            resolved[sp] = str(sp)

    # --- Step 2: Deduplicate same-role labels (Interviewer → Interviewer 1, 2, ...) ---
    from collections import Counter
    value_count = Counter(resolved.values())
    duplicate_roles = {v for v, c in value_count.items() if c > 1}

    # Track numbering per role
    role_counter = {role: 0 for role in duplicate_roles}
    effective_map = {}
    for sp, name in resolved.items():
        if name in duplicate_roles:
            role_counter[name] += 1
            effective_map[sp] = f"{name} {role_counter[name]}"
        else:
            effective_map[sp] = name

    # --- Segments ---
    for seg in segments:
        seg["speaker"] = effective_map.get(seg["speaker"], seg["speaker"])

    # --- Transcript string ---
    for old, new in effective_map.items():
        if old != new:
            transcript = transcript.replace(old, new)

    # --- Metrics keys ---
    new_metrics = {}
    for sp, data in metrics.items():
        new_key = effective_map.get(sp, sp)
        new_metrics[new_key] = data

    # --- Analysis speaker_scores keys ---
    if "speaker_scores" in analysis:
        new_scores = {}
        for sp, data in analysis["speaker_scores"].items():
            new_key = effective_map.get(sp, sp)
            new_scores[new_key] = data
        analysis["speaker_scores"] = new_scores

    # --- Final scores ---
    if "scores" in final_scores:
        new_fs = {}
        for sp, score in final_scores["scores"].items():
            new_key = effective_map.get(sp, sp)
            new_fs[new_key] = score
        final_scores["scores"] = new_fs

    if "ranking" in final_scores:
        for entry in final_scores["ranking"]:
            entry["speaker"] = effective_map.get(entry["speaker"], entry["speaker"])

    # --- Explanations keys ---
    new_exp = {}
    for sp, data in explanations.items():
        new_key = effective_map.get(sp, sp)
        new_exp[new_key] = data

    # Build the final name_map to return to the frontend
    # (uses effective names, not raw LLM output)
    final_name_map = {
        sp: effective_map.get(sp, sp)
        for sp in name_map
    }

    return transcript, new_metrics, analysis, final_scores, new_exp, final_name_map


# ---------------------------
# ROUTES
# ---------------------------

@app.route('/')
def upload_form():
    return render_template('upload.html')


@app.route('/upload', methods=['POST'])
def upload_file():
    if 'file' not in request.files:
        return jsonify({'error': 'No file part'})

    file = request.files['file']

    if file.filename == '':
        return jsonify({'error': 'No selected file'})

    topic = request.form.get("topic", "General conversation")
    num_spk = request.form.get("num_speakers", "").strip()
    num_spk = int(num_spk) if num_spk.isdigit() else None

    if file and allowed_file(file.filename):
        filename = secure_filename(file.filename)

        filepath = os.path.join(UPLOAD_FOLDER, filename)
        file.save(filepath)

        print(f"Saved file at: {filepath}")
        print(f"Meeting Topic: {topic}")
        if num_spk:
            print(f"Expected Speakers: {num_spk}")

        try:
            # ---------------------------
            # STEP 1: DIARIZATION
            # ---------------------------
            logging.info("STEP 1: Starting diarization...")
            transcript, segments = transcribe_audio(filepath, num_spk)
            logging.info(f"STEP 1 done: {len(segments)} segments")

            # ---------------------------
            # STEP 2: METRICS (deterministic)
            # ---------------------------
            logging.info("STEP 2: Computing metrics...")
            metrics = compute_all_metrics(segments, topic)
            logging.info(f"STEP 2 done: {list(metrics.keys())}")

            # ---------------------------
            # STEP 3: LLM ANALYSIS
            # ---------------------------
            logging.info("STEP 3: Running LLM analysis...")
            analysis = analyze_with_llm(transcript, topic, metrics)
            final_scores = compute_final_scores(metrics, analysis)
            explanations = generate_explanations(metrics, analysis)
            logging.info("STEP 3 done")

            # ---------------------------
            # STEP 4: SPEAKER NAME IDENTIFICATION
            # ---------------------------
            logging.info("STEP 4: Identifying speaker names/roles...")
            speaker_ids = list(metrics.keys())
            raw_name_map = identify_speaker_names(segments, speaker_ids)
            transcript, metrics, analysis, final_scores, explanations, speaker_name_map = apply_speaker_names(
                raw_name_map, segments, transcript, metrics, analysis, final_scores, explanations
            )
            logging.info(f"STEP 4 done: {speaker_name_map}")

            # ---------------------------
            # FINAL RESPONSE
            # ---------------------------
            return jsonify({
                "transcript": transcript,
                "segments": segments,
                "metrics": metrics,
                "analysis": analysis,
                "final_scores": final_scores,
                "explanations": explanations,
                "speaker_name_map": speaker_name_map
            })

        except Exception as e:
            import traceback
            tb = traceback.format_exc()
            logging.error(f"Pipeline error: {e}\n{tb}")
            return jsonify({
                "error": str(e),
                "detail": tb
            }), 500


    return jsonify({'error': 'Invalid file format'})


# ---------------------------
# RUN
# ---------------------------

if __name__ == "__main__":
    app.run(host='127.0.0.1', port=5000, debug=True)