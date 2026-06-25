// Meeting Mode — WebUI Extension
// Records audio, transcribes via STT, displays live captions,
// detects wake words to trigger agent, and runs background annotations.

(function () {
  const ANNOTATE_INTERVAL_MS = 120000;
  const WAKE_PATTERNS = [/@clacky/i, /小[克客可刻课氪]/, /clacky/i, /克拉奇/];

  // Self-contained i18n: extensions can't register keys into the host I18n
  // dictionary, so we keep our own table and pick the language via I18n.lang().
  const MEETING_I18N = {
    en: {
      "tab.label": "Meeting",
      "btn.start": "Start Meeting",
      "btn.stop": "End Meeting",
      "btn.resume": "Resume Recording",
      "hint.wake": 'Say "@clacky" or "小克" to ask a question during the meeting.',
      "hint.resume": "A meeting is still in progress. Resume recording to continue (microphone access required again).",
      "status.recording": "Recording",
      "status.transcribing": "Transcribing…",
      "status.listening": "Listening… ({{n}}s)",
      "status.thinking": "Thinking…",
      "status.speaking": "Playing…",
      "vocab.label": "Meeting vocabulary (proper nouns, comma-separated)",
      "vocab.placeholder": "e.g. Clacky, OpenClacky, 亚飞",
      "vocab.save": "Save vocabulary",
      "vocab.saved": "Saved",
      "vocab.saveFailed": "Save failed",
      "annotations.title": "Annotations",
      "stt.failed": "⚠ Transcription failed: {{msg}}",
      "alert.noSession": "No active session",
      "alert.startFailed": "Failed to start meeting: {{msg}}",
    },
    zh: {
      "tab.label": "会议",
      "btn.start": "开始会议",
      "btn.stop": "结束会议",
      "btn.resume": "继续录音",
      "hint.wake": "会议中说「@clacky」或「小克」即可向我提问。",
      "hint.resume": "有一场会议仍在进行中。点击「继续录音」继续（需要重新授权麦克风）。",
      "status.recording": "录音中",
      "status.transcribing": "识别中…",
      "status.listening": "正在听你说…（{{n}}s）",
      "status.thinking": "思考中…",
      "status.speaking": "播放中…",
      "vocab.label": "会议词汇（专有名词，逗号分隔）",
      "vocab.placeholder": "例如 Clacky, OpenClacky, 亚飞",
      "vocab.save": "保存词汇",
      "vocab.saved": "已保存",
      "vocab.saveFailed": "保存失败",
      "annotations.title": "标注",
      "stt.failed": "⚠ 识别失败：{{msg}}",
      "alert.noSession": "没有进行中的会话",
      "alert.startFailed": "开启会议失败：{{msg}}",
    },
  };

  function t(key, vars) {
    const lang = (window.I18n && I18n.lang && I18n.lang()) || "en";
    const dict = MEETING_I18N[lang] || MEETING_I18N.en;
    let str = dict[key] != null ? dict[key] : (MEETING_I18N.en[key] != null ? MEETING_I18N.en[key] : key);
    if (vars) Object.keys(vars).forEach((k) => { str = str.split("{{" + k + "}}").join(vars[k]); });
    return str;
  }

  // VAD (voice activity detection) — slice on natural speech pauses instead
  // of a fixed timer, so a sentence is never cut mid-word.
  const VAD_SILENCE_THRESHOLD = 0.012; // RMS below this counts as silence
  const VAD_SILENCE_HOLD_MS = 500;     // pause this long => end of utterance
  const VAD_MIN_SPEECH_MS = 400;       // ignore utterances shorter than this
  const VAD_MAX_SEGMENT_MS = 12000;    // force-cut a very long monologue

  const HALLUCINATION_PHRASES = new Set([
    "no", "no.", "yes", "yes.", "ok", "okay", "thank you", "thank you.",
    "thanks", "thanks for watching", "thanks for watching!", "you", "bye",
    "uh", "um", "hmm", "mm", "mm-hmm", ".", "..", "...",
    "嗯", "啊", "哦", "呃", "谢谢", "谢谢观看", "谢谢大家", "好", "好的", "对",
  ]);

  function isHallucination(text) {
    const t = text.trim();
    // Gemini wraps non-speech sounds in (parens) or [brackets]; if the whole
    // segment is just such annotations, it's noise, not speech.
    const stripped = t.replace(/[\(\[][^\)\]]*[\)\]]/g, "").trim();
    if (stripped === "") return true;
    const normalized = t.toLowerCase().replace(/[\s。，,!！?？]+/g, " ").trim();
    return normalized === "" || HALLUCINATION_PHRASES.has(normalized);
  }

  let state = {
    active: false,
    sessionId: null,
    meetingId: null,
    mediaRecorder: null,
    annotateTimer: null,
    transcripts: [],
    annotations: [],
    sttError: null,
    audioCtx: null,
    vadRaf: null,
    stream: null,
    vocabulary: "",
    conversationUntil: 0,
    expectingSpeech: false,
    asking: false,
    phase: "idle", // idle | listening | transcribing | conversation | thinking | speaking
    phaseTimer: null,
    transcribing: 0, // count of in-flight STT requests
    container: null,
    resumable: false,
  };

  function apiUrl(path) {
    return `/api/ext/meeting${path}`;
  }

  async function postJson(path, body) {
    const res = await fetch(apiUrl(path), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
  }

  function currentSessionId() {
    return state.sessionId || (window.Clacky && Clacky.ext && Clacky.ext.context.sessionId) || null;
  }

  // After a page refresh the browser forgets everything but the backend still
  // has the meeting. Probe for it and, if found, restore captions and offer a
  // "Resume Recording" button (mic access can't survive a refresh).
  async function probeActiveMeeting(container) {
    const sessionId = currentSessionId();
    if (!sessionId || state.active) return;
    try {
      const res = await fetch(apiUrl("/active/" + encodeURIComponent(sessionId)));
      const data = await res.json();
      if (!data || !data.active) return;
      state.sessionId = sessionId;
      state.meetingId = data.meeting_id;
      state.resumable = true;
      state.transcripts = (data.transcript || []).map((e) => ({
        ts: e.ts ? Date.parse(e.ts) || Date.now() : Date.now(),
        text: String(e.text || "").trim(),
      })).filter((e) => e.text);
    } catch (_e) {
      // probing is best-effort; ignore failures
    }
    renderUI(container);
  }

  async function startMeeting(container) {
    const sessionId = currentSessionId();
    if (!sessionId) {
      alert(t("alert.noSession"));
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      // Resuming an in-progress meeting (after a page refresh): keep the
      // existing meeting_id so new captions append to the same transcript.
      if (!(state.resumable && state.meetingId)) {
        const data = await postJson("/start", { session_id: sessionId });
        state.meetingId = data.meeting_id;
      }
      state.active = true;
      state.sessionId = sessionId;
      state.resumable = false;
      state.stream = stream;

      startVadRecording(stream);

      state.annotateTimer = setInterval(() => runAnnotate(), ANNOTATE_INTERVAL_MS);

      renderUI(container);
    } catch (err) {
      console.error("[meeting] start failed:", err);
      alert(t("alert.startFailed", { msg: err.message }));
    }
  }

  // Records continuously and cuts a segment only when speech is followed by a
  // sustained pause (or the segment grows too long). Each segment is a fresh,
  // self-contained webm so the STT backend can always decode it.
  function startVadRecording(stream) {
    const mime = getSupportedMime();
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    const audioCtx = new AudioCtx();
    state.audioCtx = audioCtx;
    const source = audioCtx.createMediaStreamSource(stream);
    const analyser = audioCtx.createAnalyser();
    analyser.fftSize = 1024;
    source.connect(analyser);
    const buf = new Float32Array(analyser.fftSize);

    let recorder = null;
    let chunks = [];
    let hadSpeech = false;
    let segmentStart = 0;
    let silenceStart = 0;

    function newRecorder() {
      const r = new MediaRecorder(stream, mime ? { mimeType: mime } : {});
      chunks = [];
      hadSpeech = false;
      segmentStart = performance.now();
      silenceStart = 0;
      r.ondataavailable = (e) => { if (e.data && e.data.size > 0) chunks.push(e.data); };
      r.onstop = () => {
        const captured = chunks;
        const speech = hadSpeech;
        const dur = performance.now() - segmentStart;
        if (state.active) newRecorder();
        if (speech && dur >= VAD_MIN_SPEECH_MS && captured.length) {
          sendAudioChunk(new Blob(captured, mime ? { type: mime } : {}));
        }
      };
      r.start(200); // emit chunks every 200ms so a cut loses nothing
      recorder = r;
      state.mediaRecorder = r;
    }

    function rms() {
      analyser.getFloatTimeDomainData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
      return Math.sqrt(sum / buf.length);
    }

    function tick() {
      if (!state.active) return;
      const now = performance.now();
      const level = rms();

      if (level >= VAD_SILENCE_THRESHOLD) {
        hadSpeech = true;
        silenceStart = 0;
      } else if (hadSpeech) {
        if (silenceStart === 0) silenceStart = now;
        else if (now - silenceStart >= VAD_SILENCE_HOLD_MS) {
          if (recorder.state === "recording") recorder.stop();
        }
      }

      if (now - segmentStart >= VAD_MAX_SEGMENT_MS && recorder.state === "recording") {
        recorder.stop();
      }

      state.vadRaf = requestAnimationFrame(tick);
    }

    newRecorder();
    state.vadRaf = requestAnimationFrame(tick);
  }

  async function stopMeeting(container) {
    state.active = false;
    if (state.vadRaf) cancelAnimationFrame(state.vadRaf);
    if (state.mediaRecorder && state.mediaRecorder.state !== "inactive") {
      state.mediaRecorder.stop();
    }
    if (state.stream) {
      state.stream.getTracks().forEach((t) => t.stop());
    }
    if (state.audioCtx) {
      try { await state.audioCtx.close(); } catch (_) {}
    }
    clearInterval(state.annotateTimer);

    try {
      const result = await postJson("/end", {
        session_id: state.sessionId,
        meeting_id: state.meetingId,
      });
      if (result && result.ok === false) {
        console.error("[meeting] end summarization failed:", result.error);
      } else if (result && result.skipped) {
        console.warn("[meeting] end: transcript was empty, no summary generated");
      }
    } catch (err) {
      console.error("[meeting] end failed:", err);
    }

    state.mediaRecorder = null;
    state.annotateTimer = null;
    state.transcripts = [];
    state.annotations = [];
    state.sttError = null;
    state.audioCtx = null;
    state.vadRaf = null;
    state.stream = null;
    state.conversationUntil = 0;
    state.expectingSpeech = false;
    state.asking = false;
    state.transcribing = 0;
    state.resumable = false;
    stopStatusTicker();
    renderUI(container);
  }

  const MIN_AUDIO_BYTES = 2000; // drop near-empty blobs before hitting STT

  async function sendAudioChunk(blob) {
    if (!blob || blob.size < MIN_AUDIO_BYTES) return; // too little audio to be speech
    const buf = await blob.arrayBuffer();
    const bytes = new Uint8Array(buf);
    let binary = "";
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    const base64 = btoa(binary);

    state.transcribing++;
    updateStatus();
    try {
      const result = await postJson("/transcribe", {
        session_id: state.sessionId,
        meeting_id: state.meetingId,
        audio_base64: base64,
        mime_type: blob.type,
        vocabulary: state.vocabulary,
      });

      if (result.text && result.text.trim() && !isHallucination(result.text)) {
        const entry = { ts: Date.now(), text: result.text.trim() };
        state.transcripts.push(entry);
        checkWakeWord(entry.text);
        updateCaptions();
      }
      if (state.sttError) {
        state.sttError = null;
        updateSttError();
      }
    } catch (e) {
      console.error("STT failed:", e.message);
      state.sttError = e.message;
      updateSttError();
    } finally {
      state.transcribing = Math.max(0, state.transcribing - 1);
      updateStatus();
    }
  }

  const CONVERSATION_WINDOW_MS = 30000; // after a wake word, keep listening this long without re-triggering

  function checkWakeWord(text) {
    const triggered = WAKE_PATTERNS.some((p) => p.test(text));
    const inConversation = state.conversationUntil && Date.now() < state.conversationUntil;

    if (!triggered && !inConversation) return;
    if (state.asking) return; // a question is still being answered; don't pile on

    const question = text.replace(/@clacky/gi, "").replace(/clacky/gi, "").replace(/小[克客可刻课氪]/g, "").replace(/克拉奇/g, "").trim();
    if (!question) return;

    state.conversationUntil = Date.now() + CONVERSATION_WINDOW_MS;
    state.expectingSpeech = true;
    state.asking = true;
    postJson("/ask", {
      session_id: state.sessionId,
      meeting_id: state.meetingId,
      question: question,
    }).catch((e) => {
      state.asking = false;
      console.error("[meeting] ask failed:", e.message);
    });
  }

  async function runAnnotate() {
    if (!state.active) return;
    try {
      const result = await postJson("/annotate", {
        session_id: state.sessionId,
        meeting_id: state.meetingId,
      });
      if (result.annotations && result.annotations.length > 0) {
        state.annotations.push(...result.annotations);
        updateAnnotations();
      }
    } catch (_) {}
  }

  // Single source of truth for the header status line. Priority high→low:
  // speaking > thinking > conversation(countdown) > transcribing > listening.
  function updateStatus() {
    const el = document.getElementById("meeting-status");
    if (!el) return;
    const now = Date.now();
    const inConversation = state.conversationUntil && now < state.conversationUntil;
    let text, cls;
    if (state.phase === "speaking") {
      text = t("status.speaking");
      cls = "speaking";
    } else if (state.asking) {
      text = t("status.thinking");
      cls = "thinking";
    } else if (inConversation) {
      const left = Math.ceil((state.conversationUntil - now) / 1000);
      text = t("status.listening", { n: left });
      cls = "listening";
    } else if (state.transcribing > 0) {
      text = t("status.transcribing");
      cls = "transcribing";
    } else {
      text = t("status.recording");
      cls = "recording";
    }
    el.textContent = " " + text;
    el.className = "meeting-status meeting-status-" + cls;
  }

  function startStatusTicker() {
    stopStatusTicker();
    updateStatus();
    state.phaseTimer = setInterval(updateStatus, 500);
  }

  function stopStatusTicker() {
    if (state.phaseTimer) {
      clearInterval(state.phaseTimer);
      state.phaseTimer = null;
    }
  }

  function updateSttError() {
    const el = document.getElementById("meeting-stt-error");
    if (!el) return;
    if (state.sttError) {
      el.textContent = t("stt.failed", { msg: state.sttError });
      el.style.display = "block";
    } else {
      el.textContent = "";
      el.style.display = "none";
    }
  }

  function updateCaptions() {
    const el = document.getElementById("meeting-captions");
    if (!el) return;
    const recent = state.transcripts.slice(-20);
    el.innerHTML = recent
      .map((t) => {
        const time = new Date(t.ts).toLocaleTimeString();
        return `<div class="meeting-caption"><span class="meeting-ts">${time}</span> ${escHtml(t.text)}</div>`;
      })
      .join("");
    el.scrollTop = el.scrollHeight;
  }

  function updateAnnotations() {
    const el = document.getElementById("meeting-annotations");
    if (!el) return;
    const recent = state.annotations.slice(-10);
    el.innerHTML = recent
      .map((a) => {
        const icon = a.type === "decision" ? "📋" : a.type === "action" ? "✅" : "💡";
        return `<div class="meeting-annotation">${icon} ${escHtml(a.text)}</div>`;
      })
      .join("");
  }

  function escHtml(s) {
    const d = document.createElement("div");
    d.textContent = s;
    return d.innerHTML;
  }

  function getSupportedMime() {
    const types = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/mp4"];
    for (const t of types) {
      if (MediaRecorder.isTypeSupported(t)) return t;
    }
    return "";
  }

  function renderUI(container) {
    if (!container) return;
    container.replaceChildren();

    const wrapper = document.createElement("div");
    wrapper.className = "meeting-panel";

    if (!state.active) {
      const btn = document.createElement("button");
      btn.className = "meeting-btn meeting-btn-start";
      btn.textContent = state.resumable ? t("btn.resume") : t("btn.start");
      btn.onclick = () => startMeeting(container);
      wrapper.appendChild(btn);

      const hint = document.createElement("p");
      hint.className = "meeting-hint";
      hint.textContent = state.resumable ? t("hint.resume") : t("hint.wake");
      wrapper.appendChild(hint);

      const vocabSection = document.createElement("div");
      vocabSection.className = "meeting-vocab-section";

      const vocabLabel = document.createElement("label");
      vocabLabel.className = "meeting-vocab-label";
      vocabLabel.textContent = t("vocab.label");
      vocabSection.appendChild(vocabLabel);

      const vocabInput = document.createElement("textarea");
      vocabInput.className = "meeting-vocab-input";
      vocabInput.rows = 2;
      vocabInput.placeholder = t("vocab.placeholder");
      vocabInput.value = state.vocabulary;
      vocabSection.appendChild(vocabInput);

      const vocabRow = document.createElement("div");
      vocabRow.className = "meeting-vocab-row";
      const saveBtn = document.createElement("button");
      saveBtn.className = "meeting-btn meeting-btn-vocab";
      saveBtn.textContent = t("vocab.save");
      const savedHint = document.createElement("span");
      savedHint.className = "meeting-vocab-saved";
      saveBtn.onclick = async () => {
        const value = vocabInput.value.trim();
        try {
          await postJson("/vocabulary", { vocabulary: value });
          state.vocabulary = value;
          savedHint.textContent = t("vocab.saved");
          setTimeout(() => { savedHint.textContent = ""; }, 2000);
        } catch (err) {
          savedHint.textContent = t("vocab.saveFailed");
        }
      };
      vocabRow.appendChild(saveBtn);
      vocabRow.appendChild(savedHint);
      vocabSection.appendChild(vocabRow);

      wrapper.appendChild(vocabSection);

      // When resuming after a refresh, show the captions captured so far.
      if (state.resumable && state.transcripts.length) {
        const captions = document.createElement("div");
        captions.id = "meeting-captions";
        captions.className = "meeting-captions";
        wrapper.appendChild(captions);
        wrapper._restoreCaptions = true;
      }
    } else {
      const header = document.createElement("div");
      header.className = "meeting-header";
      const dot = document.createElement("span");
      dot.className = "meeting-recording-dot";
      header.appendChild(dot);
      const label = document.createElement("span");
      label.id = "meeting-status";
      label.className = "meeting-status";
      header.appendChild(label);
      const stopBtn = document.createElement("button");
      stopBtn.className = "meeting-btn meeting-btn-stop";
      stopBtn.textContent = t("btn.stop");
      stopBtn.onclick = () => stopMeeting(container);
      header.appendChild(stopBtn);
      wrapper.appendChild(header);

      const sttError = document.createElement("div");
      sttError.id = "meeting-stt-error";
      sttError.className = "meeting-stt-error";
      sttError.style.display = "none";
      wrapper.appendChild(sttError);

      const captions = document.createElement("div");
      captions.id = "meeting-captions";
      captions.className = "meeting-captions";
      wrapper.appendChild(captions);

      const annoSection = document.createElement("div");
      annoSection.className = "meeting-annotations-section";
      const annoTitle = document.createElement("h4");
      annoTitle.textContent = t("annotations.title");
      annoSection.appendChild(annoTitle);
      const annoList = document.createElement("div");
      annoList.id = "meeting-annotations";
      annoList.className = "meeting-annotations";
      annoSection.appendChild(annoList);
      wrapper.appendChild(annoSection);

      updateCaptions();
      updateAnnotations();
      updateSttError();
      startStatusTicker();
    }

    container.appendChild(wrapper);

    if (!state.active) {
      stopStatusTicker();
      if (wrapper._restoreCaptions) updateCaptions();
    }
  }

  // Strip markdown so TTS reads clean prose, not symbols.
  function plainText(md) {
    return String(md)
      .replace(/```[\s\S]*?```/g, " ")
      .replace(/`([^`]*)`/g, "$1")
      .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/[*_#>~]/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  async function speakAnswer(content) {
    const text = plainText(content);
    if (!text) return;
    try {
      const data = await postJson("/speak", { text: text });
      if (!data.audio_base64) return;
      const audio = new Audio(`data:${data.mime_type || "audio/wav"};base64,${data.audio_base64}`);
      state.phase = "speaking";
      updateStatus();
      const clear = () => { state.phase = "idle"; updateStatus(); };
      audio.onended = clear;
      audio.onerror = clear;
      audio.play().catch(clear);
    } catch (e) {
      state.phase = "idle";
      updateStatus();
      console.error("[meeting] TTS failed:", e.message);
    }
  }

  // Speak the agent's reply aloud, but only while a meeting is live.
  Clacky.ext.subscribe("session:assistant-message", function (payload) {
    if (payload && payload.sessionId && state.sessionId && payload.sessionId !== state.sessionId) return;
    state.asking = false;
    if (!state.active) return;
    if (!state.expectingSpeech) return;
    state.expectingSpeech = false;
    speakAnswer(payload && payload.content);
  });

  // Register as a tab in the session aside panel
  Clacky.ext.ui.mount("session.aside", function (ctx) {
    const container = document.createElement("div");
    container.className = "meeting-container";
    state.container = container;
    renderUI(container);

    // Load saved vocabulary, then probe for an in-progress meeting so a page
    // refresh restores the captions instead of silently dropping them.
    fetch(apiUrl("/vocabulary"))
      .then((r) => r.json())
      .then((d) => { state.vocabulary = (d && d.vocabulary) || ""; })
      .catch(() => null)
      .then(() => probeActiveMeeting(container));

    return container;
  }, {
    tab: { id: "meeting", label: () => t("tab.label") },
    order: 200,
  });

  // Re-render on language switch so all labels follow the host language.
  document.addEventListener("langchange", function () {
    if (state.container) renderUI(state.container);
  });

  // Inject minimal styles
  const style = document.createElement("style");
  style.textContent = `
    .meeting-panel { padding: 12px; font-size: 13px; }
    .meeting-btn { padding: 8px 16px; border-radius: 6px; border: none; cursor: pointer; font-size: 13px; }
    .meeting-btn-start { background: #10b981; color: #fff; }
    .meeting-btn-start:hover { background: #059669; }
    .meeting-btn-stop { background: #ef4444; color: #fff; margin-left: auto; }
    .meeting-btn-stop:hover { background: #dc2626; }
    .meeting-hint { color: #888; margin-top: 8px; font-size: 12px; }
    .meeting-vocab-section { margin-top: 16px; border-top: 1px solid #333; padding-top: 12px; }
    .meeting-vocab-label { display: block; font-size: 12px; color: #aaa; margin-bottom: 6px; }
    .meeting-vocab-input { width: 100%; box-sizing: border-box; background: #1e1e1e; color: #eee; border: 1px solid #333; border-radius: 6px; padding: 6px 8px; font-size: 12px; resize: vertical; }
    .meeting-vocab-row { display: flex; align-items: center; gap: 8px; margin-top: 8px; }
    .meeting-btn-vocab { background: #374151; color: #fff; }
    .meeting-btn-vocab:hover { background: #4b5563; }
    .meeting-vocab-saved { font-size: 12px; color: #10b981; }
    .meeting-header { display: flex; align-items: center; gap: 8px; margin-bottom: 12px; }
    .meeting-recording-dot { width: 10px; height: 10px; border-radius: 50%; background: #ef4444; animation: meeting-pulse 1.5s infinite; }
    @keyframes meeting-pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.4; } }
    .meeting-stt-error { background: #7f1d1d; color: #fecaca; border: 1px solid #ef4444; border-radius: 6px; padding: 8px 10px; margin-bottom: 12px; font-size: 12px; line-height: 1.4; }
    .meeting-captions { max-height: 300px; overflow-y: auto; border: 1px solid #333; border-radius: 6px; padding: 8px; margin-bottom: 12px; }
    .meeting-caption { margin-bottom: 4px; line-height: 1.4; }
    .meeting-ts { color: #888; font-size: 11px; margin-right: 4px; }
    .meeting-annotations-section { border-top: 1px solid #333; padding-top: 8px; }
    .meeting-annotations-section h4 { margin: 0 0 6px; font-size: 12px; color: #aaa; }
    .meeting-annotation { margin-bottom: 4px; font-size: 12px; }
  `;
  document.head.appendChild(style);
})();
