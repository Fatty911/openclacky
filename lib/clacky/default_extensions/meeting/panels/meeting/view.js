// Meeting Mode — WebUI Extension
// Records audio, transcribes via STT, displays live captions,
// detects wake words to trigger agent, and runs background annotations.

(function () {
  const ANNOTATE_INTERVAL_MS = 120000;
  // Wake phrases must be "greeting + name", never a bare product word.
  // Bare "clacky" / "小克" are too easily tripped by casual mentions of the
  // brand or STT hallucinations pulled from the meeting vocabulary.
  // Reduplicated Chinese calls ("小克小克", "克拉奇克拉奇") are natural
  // attention-getters and count as wake too.
  const WAKE_PATTERNS = [
    /@clacky\b/i,
    /\b(hey|hi|hello|ok|okay|yo)[\s,，]+clacky\b/i,
    /(你好|嘿|喂|哎|请问)[\s,，]*小[克客可刻课氪]/,
    /(你好|嘿|喂|哎|请问)[\s,，]*克拉奇/,
    /小[克客可刻课氪][\s,，]*小[克客可刻课氪]/,
    /克拉奇[\s,，]*克拉奇/,
  ];
  const WAKE_STRIP = [
    /@clacky/gi,
    /\b(hey|hi|hello|ok|okay|yo)[\s,，]+clacky\b/gi,
    /(你好|嘿|喂|哎|请问)[\s,，]*小[克客可刻课氪]/g,
    /(你好|嘿|喂|哎|请问)[\s,，]*克拉奇/g,
    /小[克客可刻课氪][\s,，]*小[克客可刻课氪]/g,
    /克拉奇[\s,，]*克拉奇/g,
  ];

  // Self-contained i18n: extensions can't register keys into the host I18n
  // dictionary, so we keep our own table and pick the language via I18n.lang().
  const MEETING_I18N = {
    en: {
      "tab.label": "Meeting Assistant",
      "btn.start": "Start Recording",
      "btn.stop": "Summarize Notes",
      "btn.resume": "Resume Recording",
      "btn.mute": "Mute",
      "btn.unmute": "Unmute",
      "btn.mute.hint": "Temporarily stop recording (mic off)",
      "btn.silence": "Stop Voice",
      "btn.silence.hint": "Stop the current voice playback",
      "btn.interrupt": "Interrupt",
      "btn.interrupt.hint": "Cancel the current answer",
      "hint.wake": 'Say "Hey Clacky" or "@clacky" to ask a question during the meeting.',
      "hint.resume": "A meeting is still in progress. Resume recording to continue (microphone access required again).",
      "status.recording": "Recording",
      "status.transcribing": "Transcribing…",
      "status.listening": "Listening… ({{n}}s)",
      "status.thinking": "Thinking…",
      "status.speaking": "Playing…",
      "status.muted": "Muted",
      "vocab.label": "Meeting vocabulary (proper nouns)",
      "vocab.placeholder": "Type a term, press Enter",
      "vocab.save": "Save vocabulary",
      "vocab.saved": "Saved",
      "vocab.saveFailed": "Save failed",
      "annotations.title": "Annotations",
      "captions.empty": "Waiting for speech…",
      "annotations.empty": "No annotations yet",
      "stt.failed": "⚠ Transcription failed: {{msg}}",
      "alert.noSession": "No active session",
      "alert.startFailed": "Failed to start meeting: {{msg}}",
      "end.displayMessage": "🛑 Meeting ended — generating meeting minutes…",
    },
    zh: {
      "tab.label": "会议助理",
      "btn.start": "开始记录",
      "btn.stop": "总结纪要",
      "btn.resume": "继续录音",
      "btn.mute": "静音",
      "btn.unmute": "解除静音",
      "btn.mute.hint": "临时暂停录音（关闭麦克风）",
      "btn.silence": "停止播报",
      "btn.silence.hint": "停止当前语音播放",
      "btn.interrupt": "打断",
      "btn.interrupt.hint": "取消当前回答",
      "hint.wake": "会议中说「你好小克」「小克小克」或「@clacky」即可向我提问。",
      "hint.resume": "有一场会议仍在进行中。点击「继续录音」继续（需要重新授权麦克风）。",
      "status.recording": "录音中",
      "status.transcribing": "识别中…",
      "status.listening": "正在听你说…（{{n}}s）",
      "status.thinking": "思考中…",
      "status.speaking": "播放中…",
      "status.muted": "已静音",
      "vocab.label": "会议词汇（专有名词）",
      "vocab.placeholder": "输入词汇后回车添加",
      "vocab.save": "保存词汇",
      "vocab.saved": "已保存",
      "vocab.saveFailed": "保存失败",
      "annotations.title": "标注",
      "captions.empty": "正在等待发言…",
      "annotations.empty": "暂无标注",
      "stt.failed": "⚠ 识别失败：{{msg}}",
      "alert.noSession": "没有进行中的会话",
      "alert.startFailed": "开启会议失败：{{msg}}",
      "end.displayMessage": "🛑 会议结束 — 正在生成会议纪要…",
    },
  };

  function t(key, vars) {
    const lang = (typeof I18n !== "undefined" && I18n.lang && I18n.lang()) || "en";
    const dict = MEETING_I18N[lang] || MEETING_I18N.en;
    let str = dict[key] != null ? dict[key] : (MEETING_I18N.en[key] != null ? MEETING_I18N.en[key] : key);
    if (vars) Object.keys(vars).forEach((k) => { str = str.split("{{" + k + "}}").join(vars[k]); });
    return str;
  }

  // ── Layer 1: module-level (page lifetime) ────────────────────────────
  // A registry of all live meeting sessions on this page so the module-level
  // `session:assistant-message` subscription and the `langchange` listener
  // can dispatch to whichever session the event is about, without any of
  // them holding a reference to the module `state` (there is no module state).
  const _sessionsById = new Map();

  // When the agent produces a reply during meeting mode we dispatch it to the
  // matching per-session runtime — every session's meeting has its own
  // "expecting speech" flag and its own audio player.
  Clacky.ext.subscribe("session:assistant-message", function (payload) {
    const sess = payload && payload.sessionId && _sessionsById.get(payload.sessionId);
    if (sess) sess.onAssistantMessage(payload);
  });

  // Re-render every live meeting on language switch so labels follow the
  // host language.
  document.addEventListener("langchange", function () {
    _sessionsById.forEach((sess) => sess.rerender());
  });

  // ── Layer 2/3: per-session runtime ──────────────────────────────────
  // Everything below is instantiated fresh by `create(ctx)` each time a
  // session shows the meeting tab for the first time; state stays alive
  // until the session leaves the sidebar (or the page unloads).
  function createMeetingSession(ctx) {

  // VAD (voice activity detection) — slice on natural speech pauses instead
  // of a fixed timer, so a sentence is never cut mid-word.
  const VAD_SILENCE_THRESHOLD = 0.02;   // RMS below this counts as silence
  const VAD_SILENCE_HOLD_MS = 700;      // pause this long => end of utterance
  const VAD_MIN_SPEECH_MS = 500;        // ignore utterances shorter than this
  const VAD_MAX_SEGMENT_MS = 12000;     // force-cut a very long monologue
  const VAD_MIN_ACTIVE_RATIO = 0.25;    // fraction of samples above threshold
                                        // required to accept a segment

  let state = {
    active: false,
    sessionId: ctx.sessionId,
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
    micMuted: false,
    ttsAudio: null,
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
    let activeSamples = 0;
    let totalSamples = 0;

    function newRecorder() {
      const r = new MediaRecorder(stream, mime ? { mimeType: mime } : {});
      chunks = [];
      hadSpeech = false;
      segmentStart = performance.now();
      silenceStart = 0;
      activeSamples = 0;
      totalSamples = 0;
      r.ondataavailable = (e) => { if (e.data && e.data.size > 0) chunks.push(e.data); };
      r.onstop = () => {
        const captured = chunks;
        const speech = hadSpeech;
        const dur = performance.now() - segmentStart;
        const ratio = totalSamples > 0 ? activeSamples / totalSamples : 0;
        if (state.active) newRecorder();
        if (speech && dur >= VAD_MIN_SPEECH_MS && ratio >= VAD_MIN_ACTIVE_RATIO && captured.length) {
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

      totalSamples++;
      if (level >= VAD_SILENCE_THRESHOLD) {
        activeSamples++;
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
      await postJson("/end", {
        session_id: state.sessionId,
        meeting_id: state.meetingId,
        display_message: t("end.displayMessage"),
      });
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
    if (state.micMuted) return;
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

      if (result.text && result.text.trim()) {
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
  const MIN_QUESTION_CHARS = 4;
  const WAKE_ONLY_TAIL = /^\s*[?？!！。.,，]?\s*$/;

  function stripWake(text) {
    let out = text;
    for (const re of WAKE_STRIP) out = out.replace(re, " ");
    return out.replace(/[\s\p{P}]+/gu, " ").trim();
  }

  function checkWakeWord(text) {
    const triggered = WAKE_PATTERNS.some((p) => p.test(text));
    const inConversation = state.conversationUntil && Date.now() < state.conversationUntil;

    if (!triggered && !inConversation) return;

    const question = stripWake(text);
    // Wake phrase alone (no real question in the same segment): arm listening
    // but don't dispatch — the next segment will be treated as the question.
    if (triggered && WAKE_ONLY_TAIL.test(question.replace(/[\s\p{P}]/gu, ""))) {
      state.conversationUntil = Date.now() + CONVERSATION_WINDOW_MS;
      state.expectingSpeech = true;
      return;
    }
    const meaningful = question.replace(/[^\p{L}\p{N}]/gu, "");
    if (meaningful.length < MIN_QUESTION_CHARS) return;

    state.conversationUntil = Date.now() + CONVERSATION_WINDOW_MS;
    state.expectingSpeech = true;
    // A new question supersedes any in-flight answer: stop the current TTS
    // playback right away; the backend `/ask` handler will interrupt the
    // running agent turn before submitting the new one.
    stopTts();
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
    if (!el) { updateControls(); return; }
    const now = Date.now();
    const inConversation = state.conversationUntil && now < state.conversationUntil;
    let text, cls;
    if (state.micMuted) {
      text = t("status.muted");
      cls = "muted";
    } else if (state.phase === "speaking") {
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
    updateControls();
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
    if (!recent.length) {
      el.innerHTML = `<div class="meeting-empty">${escHtml(t("captions.empty"))}</div>`;
      return;
    }
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
    if (!recent.length) {
      el.innerHTML = `<div class="meeting-empty">${escHtml(t("annotations.empty"))}</div>`;
      return;
    }
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

      // Vocabulary can only be set before a meeting starts; once a meeting is
      // in progress (resume state), hide the editor since changes won't apply.
      if (!state.resumable) {
        const vocabSection = document.createElement("div");
        vocabSection.className = "meeting-vocab-section";

        const vocabLabel = document.createElement("label");
        vocabLabel.className = "meeting-vocab-label";
        vocabLabel.textContent = t("vocab.label");
        vocabSection.appendChild(vocabLabel);

        const savedHint = document.createElement("span");
        savedHint.className = "meeting-vocab-saved";

        const parseTerms = (s) =>
          String(s || "").split(/[,，]/).map((x) => x.trim()).filter(Boolean);

        const box = document.createElement("div");
        box.className = "meeting-vocab-box";

        const input = document.createElement("input");
        input.type = "text";
        input.className = "meeting-vocab-tag-input";
        input.placeholder = t("vocab.placeholder");

        const persist = async (terms) => {
          const value = terms.join(", ");
          state.vocabulary = value;
          try {
            await postJson("/vocabulary", { vocabulary: value });
            savedHint.textContent = t("vocab.saved");
            setTimeout(() => { savedHint.textContent = ""; }, 2000);
          } catch (err) {
            savedHint.textContent = t("vocab.saveFailed");
          }
        };

        const renderTags = () => {
          box.querySelectorAll(".meeting-vocab-tag").forEach((el) => el.remove());
          const terms = parseTerms(state.vocabulary);
          terms.forEach((term, i) => {
            const tag = document.createElement("span");
            tag.className = "meeting-vocab-tag";
            const label = document.createElement("span");
            label.textContent = term;
            const x = document.createElement("button");
            x.type = "button";
            x.className = "meeting-vocab-tag-x";
            x.textContent = "×";
            x.onclick = () => {
              const next = parseTerms(state.vocabulary);
              next.splice(i, 1);
              persist(next);
              renderTags();
            };
            tag.appendChild(label);
            tag.appendChild(x);
            box.insertBefore(tag, input);
          });
        };

        const addTerm = (raw) => {
          const term = String(raw || "").trim();
          if (!term) return;
          const terms = parseTerms(state.vocabulary);
          if (terms.includes(term)) { input.value = ""; return; }
          terms.push(term);
          persist(terms);
          input.value = "";
          renderTags();
        };

        input.addEventListener("keydown", (e) => {
          if (e.key === "Enter" || e.key === ",") {
            e.preventDefault();
            addTerm(input.value);
          } else if (e.key === "Backspace" && !input.value) {
            const terms = parseTerms(state.vocabulary);
            if (terms.length) { terms.pop(); persist(terms); renderTags(); }
          }
        });
        input.addEventListener("blur", () => addTerm(input.value));
        box.onclick = () => input.focus();

        box.appendChild(input);
        renderTags();
        vocabSection.appendChild(box);
        vocabSection.appendChild(savedHint);

        wrapper.appendChild(vocabSection);
      }

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

      const muteBtn = document.createElement("button");
      muteBtn.id = "meeting-mute-btn";
      muteBtn.className = "meeting-btn meeting-btn-mute";
      muteBtn.textContent = state.micMuted ? t("btn.unmute") : t("btn.mute");
      muteBtn.title = t("btn.mute.hint");
      muteBtn.onclick = toggleMic;

      const stopTtsBtn = document.createElement("button");
      stopTtsBtn.id = "meeting-stop-tts";
      stopTtsBtn.className = "meeting-btn meeting-btn-silence";
      stopTtsBtn.textContent = t("btn.silence");
      stopTtsBtn.title = t("btn.silence.hint");
      stopTtsBtn.style.display = state.phase === "speaking" ? "" : "none";
      stopTtsBtn.onclick = stopTts;

      const interruptBtn = document.createElement("button");
      interruptBtn.id = "meeting-interrupt-btn";
      interruptBtn.className = "meeting-btn meeting-btn-interrupt";
      interruptBtn.textContent = t("btn.interrupt");
      interruptBtn.title = t("btn.interrupt.hint");
      interruptBtn.style.display = state.asking ? "" : "none";
      interruptBtn.onclick = interruptAsk;

      header.appendChild(muteBtn);
      header.appendChild(stopTtsBtn);
      header.appendChild(interruptBtn);
      header.appendChild(stopBtn);
      wrapper.appendChild(header);

      const activeHint = document.createElement("p");
      activeHint.className = "meeting-hint meeting-hint-active";
      activeHint.textContent = t("hint.wake");
      wrapper.appendChild(activeHint);

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
    }

    container.appendChild(wrapper);

    if (state.active) {
      updateCaptions();
      updateAnnotations();
      updateSttError();
      startStatusTicker();
    } else {
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
      state.ttsAudio = audio;
      state.phase = "speaking";
      updateStatus();
      const clear = () => {
        if (state.ttsAudio === audio) state.ttsAudio = null;
        state.phase = "idle";
        updateStatus();
      };
      audio.onended = clear;
      audio.onerror = clear;
      audio.play().catch(clear);
    } catch (e) {
      state.phase = "idle";
      updateStatus();
      console.error("[meeting] TTS failed:", e.message);
    }
  }

  function stopTts() {
    const a = state.ttsAudio;
    if (!a) return;
    try { a.pause(); a.currentTime = 0; } catch (_) {}
    state.ttsAudio = null;
    if (state.phase === "speaking") {
      state.phase = "idle";
      updateStatus();
    }
  }

  function toggleMic() {
    if (!state.stream) return;
    const tracks = state.stream.getAudioTracks();
    if (!tracks.length) return;
    state.micMuted = !state.micMuted;
    tracks.forEach((t) => { t.enabled = !state.micMuted; });
    updateStatus();
    updateControls();
  }

  function interruptAsk() {
    stopTts();
    state.asking = false;
    state.expectingSpeech = false;
    state.conversationUntil = 0;
    try {
      if (Clacky.WS && typeof Clacky.WS.send === "function") {
        Clacky.WS.send({ type: "interrupt", session_id: state.sessionId });
      }
    } catch (e) {
      console.error("[meeting] interrupt send failed:", e && e.message);
    }
    updateStatus();
    updateControls();
  }

  function updateControls() {
    if (!state.container) return;
    const muteBtn = state.container.querySelector("#meeting-mute-btn");
    if (muteBtn) {
      muteBtn.textContent = state.micMuted ? t("btn.unmute") : t("btn.mute");
      muteBtn.classList.toggle("meeting-btn-muted", state.micMuted);
    }
    const stopTtsBtn = state.container.querySelector("#meeting-stop-tts");
    if (stopTtsBtn) stopTtsBtn.style.display = state.phase === "speaking" ? "" : "none";
    const interruptBtn = state.container.querySelector("#meeting-interrupt-btn");
    if (interruptBtn) interruptBtn.style.display = state.asking ? "" : "none";
  }

    // Handler dispatched from the module-level assistant-message subscription.
    //  - if we're expecting speech (a wake-word triggered ask), speak it and
    //    keep `asking` locked until playback ends (or fails).
    //  - otherwise release `asking` immediately.
    function onAssistantMessage(payload) {
      if (!state.active || !state.expectingSpeech) {
        state.asking = false;
        updateStatus();
        return;
      }
      state.expectingSpeech = false;
      speakAnswer(payload && payload.content);
    }

    // Register into the module registry so cross-session events reach us.
    _sessionsById.set(ctx.sessionId, {
      onAssistantMessage,
      rerender() { if (state.container) renderUI(state.container); },
    });

    // Kick off vocabulary + resume probe eagerly so the tab is ready even
    // before the user first opens it (create runs on first render).
    fetch(apiUrl("/vocabulary"))
      .then((r) => r.json())
      .then((d) => {
        state.vocabulary = (d && d.vocabulary) || "";
        if (state.container) renderUI(state.container);
      })
      .catch(() => null)
      .then(() => probeActiveMeeting(state.container));

    return {
      state,
      // Every tab activation gets a fresh empty container; wire it into state
      // and paint the current state onto it.
      attach(container) {
        state.container = container;
        renderUI(container);
      },
      // Session left the sidebar for good — release recorder / audio / timers.
      dispose() {
        _sessionsById.delete(ctx.sessionId);
        state.active = false;
        if (state.vadRaf) cancelAnimationFrame(state.vadRaf);
        try { if (state.mediaRecorder && state.mediaRecorder.state !== "inactive") state.mediaRecorder.stop(); } catch (_) {}
        if (state.stream) state.stream.getTracks().forEach((t) => t.stop());
        if (state.audioCtx) { try { state.audioCtx.close(); } catch (_) {} }
        clearInterval(state.annotateTimer);
        stopStatusTicker();
        stopTts();
      },
    };
  }

  Clacky.ext.ui.mount("session.aside", {
    create(ctx) { return createMeetingSession(ctx); },
    render(container, ctx, runtime) { runtime.attach(container); },
  }, {
    tab: { id: "meeting", label: () => t("tab.label") },
    order: 200,
  });

  // Inject minimal styles
  const style = document.createElement("style");
  style.textContent = `
    .meeting-panel { padding: 16px; font-size: 13px; color: var(--color-text-secondary); }
    .meeting-btn { padding: 7px 14px; border-radius: var(--radius-sm); border: 1px solid transparent; cursor: pointer; font-size: 13px; font-weight: 500; transition: background .15s, border-color .15s; }
    .meeting-btn-start { background: var(--color-button-primary); color: var(--color-button-primary-text); }
    .meeting-btn-start:hover { background: var(--color-button-primary-hover); }
    .meeting-btn-stop { background: transparent; color: var(--color-error); border-color: var(--color-error-border); }
    .meeting-btn-stop:hover { background: var(--color-error-bg); }
    .meeting-btn-mute, .meeting-btn-silence, .meeting-btn-interrupt { background: transparent; color: var(--color-text-secondary); border-color: var(--color-border-primary); }
    .meeting-btn-mute:hover, .meeting-btn-silence:hover, .meeting-btn-interrupt:hover { background: var(--color-bg-hover); color: var(--color-text-primary); }
    .meeting-btn-mute.meeting-btn-muted { color: var(--color-error); border-color: var(--color-error-border); background: var(--color-error-bg); }
    .meeting-btn-silence, .meeting-btn-interrupt { color: var(--color-warning, var(--color-text-secondary)); border-color: var(--color-warning-border, var(--color-border-primary)); }
    .meeting-header .meeting-btn-mute { margin-left: auto; }
    .meeting-header .meeting-btn-mute + .meeting-btn { margin-left: 6px; }
    .meeting-hint { color: var(--color-text-tertiary); margin: 10px 0 0; font-size: 12px; line-height: 1.5; }
    .meeting-hint-active { margin: 8px 0 4px; font-size: 11px; opacity: 0.75; }
    .meeting-vocab-section { margin-top: 20px; border-top: 1px solid var(--color-border-primary); padding-top: 16px; }
    .meeting-vocab-label { display: block; font-size: 12px; color: var(--color-text-tertiary); margin-bottom: 6px; }
    .meeting-vocab-box { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; width: 100%; box-sizing: border-box; background: var(--color-bg-input); border: 1px solid var(--color-border-primary); border-radius: var(--radius-sm); padding: 6px 8px; cursor: text; min-height: 36px; }
    .meeting-vocab-box:focus-within { border-color: var(--color-accent-primary); }
    .meeting-vocab-tag { display: inline-flex; align-items: center; gap: 4px; background: var(--color-bg-hover); color: var(--color-text-primary); border: 1px solid var(--color-border-primary); border-radius: var(--radius-sm); padding: 2px 4px 2px 8px; font-size: 12px; line-height: 1.4; }
    .meeting-vocab-tag-x { background: none; border: none; color: var(--color-text-muted); cursor: pointer; font-size: 14px; line-height: 1; padding: 0 2px; }
    .meeting-vocab-tag-x:hover { color: var(--color-text-primary); }
    .meeting-vocab-tag-input { flex: 1; min-width: 80px; background: none; border: none; outline: none; color: var(--color-text-primary); font-size: 12px; font-family: inherit; padding: 2px 0; }
    .meeting-vocab-tag-input::placeholder { color: var(--color-text-muted); }
    .meeting-vocab-saved { display: block; font-size: 12px; color: var(--color-success); margin-top: 8px; min-height: 14px; }
    .meeting-header { display: flex; align-items: center; gap: 8px; margin-bottom: 14px; }
    .meeting-recording-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--color-error); animation: meeting-pulse 1.5s infinite; flex: none; }
    @keyframes meeting-pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.3; } }
    .meeting-status { font-size: 13px; color: var(--color-text-secondary); }
    .meeting-status-thinking, .meeting-status-listening { color: var(--color-accent-primary); }
    .meeting-status-speaking { color: var(--color-success); }
    .meeting-stt-error { background: var(--color-error-bg); color: var(--color-error); border: 1px solid var(--color-error-border); border-radius: var(--radius-sm); padding: 8px 10px; margin-bottom: 12px; font-size: 12px; line-height: 1.4; }
    .meeting-captions { max-height: 300px; overflow-y: auto; border: 1px solid var(--color-border-primary); border-radius: var(--radius-sm); padding: 10px; margin: 14px 0; background: var(--color-bg-secondary); }
    .meeting-caption { margin-bottom: 5px; line-height: 1.5; color: var(--color-text-primary); }
    .meeting-ts { color: var(--color-text-muted); font-size: 11px; margin-right: 6px; }
    .meeting-annotations-section { border-top: 1px solid var(--color-border-primary); padding-top: 12px; }
    .meeting-annotations-section h4 { margin: 0 0 8px; font-size: 12px; font-weight: 600; color: var(--color-text-tertiary); }
    .meeting-annotation { margin-bottom: 5px; font-size: 12px; line-height: 1.5; }
    .meeting-empty { color: var(--color-text-muted); font-size: 12px; padding: 2px 0; }
    .meeting-captions:has(.meeting-empty) { border: none; padding: 0; background: none; }
  `;
  document.head.appendChild(style);
})();
