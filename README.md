# Diarized Speech Transcription and Speaker Analysis 🎙️📊

A state-of-the-art meeting intelligence platform that transforms raw audio into a structured, speaker-labeled transcript with deep analytical insights. Powered by **Groq**, **Pyannote**, and **LLaMA 3**.

---

## 🌟 Overview

This project is a comprehensive solution for analyzing conversations. It goes beyond simple transcription by identifying *who* said *what* and evaluating their contribution based on sentiment, confidence, and topic relevance. It features a premium, interactive dashboard for visualization and manual refinement.

---

## 🚀 Key Features

- **Blazing Fast Transcription**: Leverages Groq's LPU-powered Whisper Large v3 for near-instant transcription.
- **Intelligent Speaker Diarization**: Uses `pyannote.audio` and `SpeechBrain` embeddings to distinguish between speaker voices.
- **AI Speaker Identification**: Automatically infers real names or roles (e.g., "Interviewer", "Candidate") from the conversation flow.
- **Deep Performance Metrics**:
  - **Speaking Share %**: Participation balance.
  - **Sentiment Analysis**: Emotional tone of each speaker.
  - **Confidence Scores**: Measuring assertive vs. uncertain language.
  - **Topic Alignment**: How closely each speaker stuck to the intended agenda.
- **Interactive Dashboard**: A modern, sleek UI for viewing transcripts, performance charts, and live-editing speaker labels.

---

## 🛠️ Tech Stack

### Backend
- **Core**: Python 3.12, Flask
- **Concurrency**: `ThreadPoolExecutor` for parallel LLM analysis.
- **API**: Groq SDK

### AI & Speech
- **Transcription**: Groq (Whisper-Large-v3)
- **Diarization**: Pyannote.audio, SpeechBrain (ECAPA-VOXCELEB)
- **clustering**: Agglomerative Clustering (Scikit-learn)
- **Intelligence**: LLaMA 3.3-70B & 3.1-8B (Fallback)

### Frontend
- **Logic**: Vanilla JavaScript (ES6+)
- **Styling**: Vanilla CSS3 (Modern, Responsive Design)
- **Assets**: FFmpeg (for robust audio preprocessing/compression)

---

## 🔄 The Pipeline

1.  **Preprocessing**: FFmpeg handles dual-stream decoding — producing a 16kHz WAV for diarization and a high-efficiency MP3 for Groq.
2.  **Diarization**: Pyannote generates voice embeddings, and Scikit-learn clusters them to identify unique speaker IDs.
3.  **Transcription**: Groq's Whisper API converts the audio to time-stamped text segments.
4.  **Parallel Analysis**:
    - **Topic Metrics**: Compares segments against the meeting topic using LLMs.
    - **Contextual Analysis**: Extracts intent, summary, and action items.
    - **Identity Mapping**: Infers names/roles from speech patterns.
5.  **Scoring & Ranking**: A weighted algorithm computes a final "Performance Score" based on all gathered data points.

---

## 📦 Installation & Setup

### Prerequisites
- Python 3.12+
- FFmpeg installed and added to PATH
- Groq API Key

### Steps
1. **Clone the project**:
   ```bash
   git clone https://github.com/abhinav-24git/Diarized-Speech-Transcription-and-Speaker-Analysis.git
   cd Diarized-Speech-Transcription-and-Speaker-Analysis
   ```

2. **Set up Virtual Environment**:
   ```bash
   python -m venv venv
   source venv/bin/activate  # Windows: venv\Scripts\activate
   ```

3. **Install Dependencies**:
   ```bash
   pip install -r requirements.txt
   ```

4. **Environment Variables**:
   Set your Groq API key:
   ```bash
   export GROQ_API_KEY="your_key_here"  # Windows: $env:GROQ_API_KEY="your_key_here"
   ```

5. **Run the Application**:
   ```bash
   python main.py
   ```
   Access at `http://127.0.0.1:5000`

---

## 🔮 Future Roadmap

- **Live Streaming Support**: Real-time diarization and transcription for live meetings.
- **Multi-Modal Analysis**: Integrating video/visual cues for enhanced speaker identification.
- **Advanced Summarization**: Generating tailored reports for HR, Project Managers, or Stakeholders.
- **Platform Integration**: Native plug-ins for Zoom, Google Meet, and Microsoft Teams.
- **Emotional AI**: Detecting nuanced emotions (frustration, excitement, hesitation) beyond basic sentiment.

---

## 📄 License

Individual/Educational - See the repository for details.

---

*Made with ❤️ for advanced conversational intelligence.*
