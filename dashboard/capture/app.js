/**
 * CHS Capture — front-end controller.
 *
 * Implemented so far:
 *   - Phase 2: screen routing, job switcher, current-job persistence,
 *     service-worker registration (SW itself is a no-op stub).
 *   - Phase 3: camera invocation, client-side thumb generation, category
 *     tagging on the Review screen, multipart POST to /api/photos.
 *
 * Coming:
 *   Phase 4 — voice recording, Web Speech transcription, note POST.
 *   Phase 5 — IndexedDB queue + pending UI badge + background sync.
 */

(function () {
  'use strict';

  const STORAGE_KEY = 'chs-capture:current-job';
  const ACTIVE_JOBS_URL = '/api/jobs/active';
  const PHOTOS_URL = '/api/photos';
  const NOTES_URL = '/api/notes';
  const CLAUDE_PROXY_URL = 'https://chs-claude-proxy.tony-bc5.workers.dev';
  const THUMB_MAX_EDGE = 800;          // px; longest edge of the generated thumbnail
  const THUMB_QUALITY = 0.85;          // JPEG quality for the thumb

  /** @type {{ id: string|null, title: string|null, meta: string|null }} */
  let currentJob = loadCurrentJob();
  /** @type {Array<{id: string, job_number: number|null, title: string|null, status: string|null, client_name: string|null, address: string|null}>} */
  let activeJobs = [];

  /**
   * Holds the photo currently being reviewed before submit. Cleared after
   * a successful upload or when the user discards.
   * @type {{ original: File|null, originalUrl: string|null, thumb: Blob|null, takenAt: string, gpsLat: number|null, gpsLng: number|null, category: string }|null}
   */
  let pendingPhoto = null;

  /**
   * Voice-screen state. `target` is "job" or "general" — controls whether
   * the saved note inherits currentJob.id or is forced to NULL.
   * `recognition` is the live SpeechRecognition handle while recording.
   * `finalText` is the accumulated final transcript across utterances;
   * `interimText` is whatever the recognizer is still finalizing.
   *
   * @type {{ target: 'job'|'general', recognition: any|null, finalText: string, interimText: string, startedAt: number|null, timerId: number|null, saving: boolean }}
   */
  let voiceState = {
    target: 'job',
    recognition: null,
    finalText: '',
    interimText: '',
    startedAt: null,
    timerId: null,
    saving: false,
  };

  /** Restore { id, title, meta } from localStorage; tolerate missing/garbage. */
  function loadCurrentJob() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return { id: null, title: null, meta: null };
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        return {
          id: typeof parsed.id === 'string' ? parsed.id : null,
          title: typeof parsed.title === 'string' ? parsed.title : null,
          meta: typeof parsed.meta === 'string' ? parsed.meta : null,
        };
      }
    } catch (_) { /* fall through */ }
    return { id: null, title: null, meta: null };
  }

  function saveCurrentJob() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(currentJob)); }
    catch (_) { /* localStorage may be disabled in private mode; non-fatal */ }
  }

  /** Update the job-strip UI on Home from the current selection. */
  function renderCurrentJob() {
    const strip = document.getElementById('cap-current-job');
    const titleEl = document.getElementById('cap-current-job-title');
    const metaEl = document.getElementById('cap-current-job-meta');
    if (!strip || !titleEl || !metaEl) return;

    if (currentJob.id) {
      strip.dataset.mode = 'job';
      titleEl.textContent = currentJob.title || 'Job (no title)';
      metaEl.textContent = currentJob.meta || 'Photos & voice notes will attach here.';
    } else {
      strip.dataset.mode = 'general';
      titleEl.textContent = 'General (no job selected)';
      metaEl.textContent = 'Tap “Switch” to attach photos & notes to a job.';
    }
  }

  /** Show one of the .cap-screen sections; hide all others. */
  function showScreen(name) {
    document.querySelectorAll('.cap-screen').forEach((el) => {
      el.dataset.active = el.dataset.screen === name ? 'true' : 'false';
    });
    document.querySelectorAll('.cap-navbtn').forEach((btn) => {
      // Bottom nav highlights Home/Camera/Voice; other screens leave nav inactive.
      const action = btn.dataset.action;
      const matches =
        (action === 'goto-home' && name === 'home') ||
        (action === 'goto-camera' && name === 'camera') ||
        (action === 'goto-voice' && name === 'voice');
      btn.dataset.active = matches ? 'true' : 'false';
    });
    if (name === 'switch-job') ensureActiveJobsLoaded();
    if (name === 'voice') renderVoiceJobStrip();
    if (name === 'pending') {
      // Refresh the list whenever the user navigates here, and quietly
      // poke the SW to drain in case Background Sync is unsupported.
      renderPendingList();
      requestServiceWorkerDrain();
    }
    // Stop a live recording if the user navigates away from the voice screen.
    if (name !== 'voice' && voiceState.recognition) stopRecording();
  }

  /** Lazy-load active jobs the first time the switcher is opened. */
  let jobsLoadInflight = null;
  function ensureActiveJobsLoaded() {
    if (activeJobs.length > 0) return;
    if (jobsLoadInflight) return;
    jobsLoadInflight = fetch(ACTIVE_JOBS_URL, { credentials: 'include' })
      .then((r) => {
        if (!r.ok) throw new Error('http ' + r.status);
        return r.json();
      })
      .then((payload) => {
        activeJobs = Array.isArray(payload.jobs) ? payload.jobs : [];
        renderJobList(document.getElementById('cap-job-search')?.value || '');
      })
      .catch((err) => {
        toast('Could not load jobs: ' + err.message);
      })
      .finally(() => { jobsLoadInflight = null; });
  }

  /** Render the job list, optionally filtered by a substring query. */
  function renderJobList(query) {
    const list = document.getElementById('cap-job-list');
    if (!list) return;
    const q = (query || '').trim().toLowerCase();
    const filtered = !q
      ? activeJobs
      : activeJobs.filter((j) => {
          const hay = [
            j.title || '',
            j.client_name || '',
            j.address || '',
            j.job_number ? '#' + j.job_number : '',
            j.status || '',
          ].join(' ').toLowerCase();
          return hay.includes(q);
        });

    // Always keep the "general" row at the top so it's a one-tap escape hatch.
    const generalRow = `
      <button class="cap-jobrow cap-jobrow--general" data-job-id="">
        <span class="cap-jobrow-num">GENERAL</span>
        <span class="cap-jobrow-title">No specific job</span>
        <span class="cap-jobrow-meta">Office supplies, marketing, miscellaneous.</span>
      </button>`;

    const jobRows = filtered.map((j) => {
      const num = j.job_number ? '#' + j.job_number : (j.status || 'JOB').toUpperCase();
      const meta = [j.client_name, j.address].filter(Boolean).join(' · ') || (j.status || '');
      return `
        <button class="cap-jobrow" data-job-id="${escapeAttr(j.id)}" data-job-title="${escapeAttr(j.title || '')}" data-job-meta="${escapeAttr(meta)}">
          <span class="cap-jobrow-num">${escapeHtml(num)}</span>
          <span class="cap-jobrow-title">${escapeHtml(j.title || '(no title)')}</span>
          <span class="cap-jobrow-meta">${escapeHtml(meta)}</span>
        </button>`;
    }).join('');

    list.innerHTML = generalRow + jobRows;
  }

  /** Selecting a job from the switcher updates state and snaps back to Home. */
  function selectJob(jobId, title, meta) {
    if (jobId) {
      currentJob = { id: jobId, title: title || null, meta: meta || null };
    } else {
      currentJob = { id: null, title: null, meta: null };
    }
    saveCurrentJob();
    renderCurrentJob();
    showScreen('home');
    toast(jobId ? 'Job selected' : 'Switched to General');
  }

  function toast(msg) {
    const el = document.getElementById('cap-toast');
    if (!el) return;
    el.textContent = msg;
    el.dataset.visible = 'true';
    setTimeout(() => { el.dataset.visible = 'false'; }, 2200);
  }

  // ── Photo capture flow (Phase 3) ─────────────────────────────────

  /** Open the native camera by triggering the hidden file input. */
  function openCamera() {
    const input = /** @type {HTMLInputElement|null} */ (document.getElementById('cap-camera-input'));
    if (!input) return;
    // Reset value so the same photo could (in theory) be re-picked.
    input.value = '';
    input.click();
  }

  /**
   * File picker callback. Reads the captured file, generates a thumbnail
   * via <canvas>, optionally captures GPS, and switches to the Review screen.
   *
   * @param {Event} ev
   */
  async function onCameraInput(ev) {
    const input = /** @type {HTMLInputElement} */ (ev.target);
    const file = input.files && input.files[0];
    if (!file) return;

    try {
      const thumb = await generateThumb(file);
      const gps = await readGpsBestEffort();
      // Use the file's lastModified if it's recent, else "now". Some platforms
      // return 0 for camera captures, in which case we fall back to now.
      const lm = file.lastModified || 0;
      const takenAt = lm > 0 ? new Date(lm).toISOString() : new Date().toISOString();

      // Revoke any previous preview URL so we don't leak object URLs.
      if (pendingPhoto?.originalUrl) URL.revokeObjectURL(pendingPhoto.originalUrl);

      pendingPhoto = {
        original: file,
        originalUrl: URL.createObjectURL(file),
        thumb,
        takenAt,
        gpsLat: gps?.lat ?? null,
        gpsLng: gps?.lng ?? null,
        category: 'progress',
      };

      renderReview();
      showScreen('review');
    } catch (err) {
      console.error('Camera capture failed:', err);
      toast('Could not process photo: ' + (err && err.message ? err.message : 'unknown'));
    }
  }

  /**
   * Resize an image to a max edge of THUMB_MAX_EDGE and return a JPEG Blob.
   * Used for the thumbnail; the original file is uploaded as-is alongside.
   *
   * @param {File} file
   * @returns {Promise<Blob>}
   */
  function generateThumb(file) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      const url = URL.createObjectURL(file);
      img.onload = () => {
        try {
          const { width: w, height: h } = img;
          const longest = Math.max(w, h);
          const scale = longest > THUMB_MAX_EDGE ? THUMB_MAX_EDGE / longest : 1;
          const tw = Math.round(w * scale);
          const th = Math.round(h * scale);
          const canvas = document.createElement('canvas');
          canvas.width = tw;
          canvas.height = th;
          const ctx = canvas.getContext('2d');
          if (!ctx) throw new Error('canvas context unavailable');
          ctx.drawImage(img, 0, 0, tw, th);
          canvas.toBlob(
            (blob) => {
              URL.revokeObjectURL(url);
              if (!blob) {
                reject(new Error('toBlob returned null'));
                return;
              }
              resolve(blob);
            },
            'image/jpeg',
            THUMB_QUALITY,
          );
        } catch (err) {
          URL.revokeObjectURL(url);
          reject(err);
        }
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error('Image failed to decode'));
      };
      img.src = url;
    });
  }

  /**
   * Read the device GPS once with a short timeout. Errors and denials
   * resolve to null so the upload still proceeds without coordinates.
   * @returns {Promise<{lat: number, lng: number}|null>}
   */
  function readGpsBestEffort() {
    if (!('geolocation' in navigator)) return Promise.resolve(null);
    return new Promise((resolve) => {
      navigator.geolocation.getCurrentPosition(
        (pos) => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
        () => resolve(null),
        { enableHighAccuracy: false, timeout: 4000, maximumAge: 60000 },
      );
    });
  }

  /** Paint the Review screen from `pendingPhoto` + currentJob. */
  function renderReview() {
    if (!pendingPhoto) return;
    const img = /** @type {HTMLImageElement|null} */ (document.getElementById('cap-review-img'));
    if (img && pendingPhoto.originalUrl) img.src = pendingPhoto.originalUrl;

    const stripEl = document.getElementById('cap-review-jobstrip');
    const titleEl = document.getElementById('cap-review-job-title');
    const metaEl = document.getElementById('cap-review-job-meta');
    if (stripEl && titleEl && metaEl) {
      if (currentJob.id) {
        stripEl.dataset.mode = 'job';
        titleEl.textContent = currentJob.title || 'Job (no title)';
        metaEl.textContent = currentJob.meta || 'Photo will attach to this job.';
      } else {
        stripEl.dataset.mode = 'general';
        titleEl.textContent = 'General';
        metaEl.textContent = 'No specific job. Use “Change” to attach.';
      }
    }

    document.querySelectorAll('#cap-cat-grid .cap-cat').forEach((b) => {
      b.dataset.selected = b.dataset.category === pendingPhoto.category ? 'true' : 'false';
    });

    const captionEl = /** @type {HTMLInputElement|null} */ (document.getElementById('cap-review-caption'));
    if (captionEl) captionEl.value = '';
  }

  /** Click handler for the category tiles on the Review screen. */
  function onCategoryClick(target) {
    if (!pendingPhoto) return;
    const cat = target.dataset.category;
    if (!cat) return;
    pendingPhoto.category = cat;
    document.querySelectorAll('#cap-cat-grid .cap-cat').forEach((b) => {
      b.dataset.selected = b === target ? 'true' : 'false';
    });
  }

  /** Throw away the in-progress photo and bounce back to Home. */
  function discardPendingPhoto() {
    if (pendingPhoto?.originalUrl) URL.revokeObjectURL(pendingPhoto.originalUrl);
    pendingPhoto = null;
    showScreen('home');
  }

  /**
   * Build the multipart body and POST to /api/photos. On success we toast,
   * clear pendingPhoto, and snap to Home. On failure we keep pendingPhoto
   * intact so the crew can retry — Phase 5 will hook this into IndexedDB
   * for true offline queueing.
   */
  async function submitPendingPhoto() {
    if (!pendingPhoto || !pendingPhoto.original || !pendingPhoto.thumb) {
      toast('No photo to upload');
      return;
    }

    const submitBtn = document.querySelector('[data-action="submit-photo"]');
    const submitTitle = document.getElementById('cap-submit-title');
    const submitSub = document.getElementById('cap-submit-sub');
    if (submitBtn) submitBtn.setAttribute('disabled', 'true');
    if (submitTitle) submitTitle.textContent = 'Uploading…';
    if (submitSub) submitSub.textContent = 'Sending photo + thumbnail.';

    const captionEl = /** @type {HTMLInputElement|null} */ (document.getElementById('cap-review-caption'));
    const caption = captionEl ? captionEl.value.trim() : '';

    const metadata = {
      job_id: currentJob.id || null,
      category: pendingPhoto.category,
      taken_at: pendingPhoto.takenAt,
      gps_lat: pendingPhoto.gpsLat,
      gps_lng: pendingPhoto.gpsLng,
      caption: caption || null,
    };

    const form = new FormData();
    form.append('original', pendingPhoto.original, suggestedFilename(pendingPhoto.original));
    form.append('thumb', pendingPhoto.thumb, 'thumb.jpg');
    form.append('metadata', JSON.stringify(metadata));

    try {
      const res = await fetch(PHOTOS_URL, { method: 'POST', body: form, credentials: 'include' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const payload = await res.json();
      if (!payload || !payload.photo) throw new Error('unexpected response shape');
      // Success — wipe state, snap home, toast.
      if (pendingPhoto.originalUrl) URL.revokeObjectURL(pendingPhoto.originalUrl);
      pendingPhoto = null;
      showScreen('home');
      toast(currentJob.id ? 'Photo uploaded to job' : 'Photo uploaded (general)');
    } catch (err) {
      console.error('Photo upload failed:', err);
      // Persist the exact bytes + metadata into IDB so the service
      // worker can replay this once connectivity returns. The user
      // can keep working — pending count climbs in the corner.
      const enqueued = await tryEnqueuePhoto(metadata);
      if (enqueued) {
        if (pendingPhoto.originalUrl) URL.revokeObjectURL(pendingPhoto.originalUrl);
        pendingPhoto = null;
        showScreen('home');
        toast('Saved offline — will upload when reconnected');
        refreshPendingBadge();
      } else {
        toast('Upload failed — tap Upload to retry');
      }
    } finally {
      if (submitBtn) submitBtn.removeAttribute('disabled');
      if (submitTitle) submitTitle.textContent = 'Upload photo';
      if (submitSub) submitSub.textContent = 'Sends both the original and a 800px thumbnail.';
    }
  }

  // ── Voice note flow (Phase 4) ────────────────────────────────────

  /**
   * Echo the chosen voice target (job vs general) into the read-only
   * job strip on the Voice screen. Mirrors the Review screen pattern.
   */
  function renderVoiceJobStrip() {
    const strip = document.getElementById('cap-voice-jobstrip');
    const titleEl = document.getElementById('cap-voice-job-title');
    const metaEl = document.getElementById('cap-voice-job-meta');
    if (!strip || !titleEl || !metaEl) return;

    const useJob = voiceState.target === 'job' && currentJob.id;
    if (useJob) {
      strip.dataset.mode = 'job';
      titleEl.textContent = currentJob.title || 'Job (no title)';
      metaEl.textContent = currentJob.meta || 'Note will attach to this job.';
    } else {
      strip.dataset.mode = 'general';
      if (voiceState.target === 'job' && !currentJob.id) {
        // User picked "Attach to job" but no job is selected — guide them.
        titleEl.textContent = 'No job selected';
        metaEl.textContent = 'Tap “Change” to choose a job, or switch to General.';
      } else {
        titleEl.textContent = 'General';
        metaEl.textContent = 'Note will save without a job.';
      }
    }
  }

  /** Switch the voice target between "job" and "general" tabs. */
  function setVoiceTarget(target) {
    if (target !== 'job' && target !== 'general') return;
    voiceState.target = target;
    document.querySelectorAll('.cap-voice-toggle-btn').forEach((b) => {
      b.dataset.active = b.dataset.voiceTarget === target ? 'true' : 'false';
    });
    renderVoiceJobStrip();
  }

  /**
   * Build the SpeechRecognition object. Returns null if the browser
   * doesn't support the Web Speech API (older Android, Firefox, etc.) —
   * in that case the user can still type the transcript manually.
   */
  function buildRecognition() {
    const Ctor = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!Ctor) return null;
    const rec = new Ctor();
    rec.continuous = true;        // keep listening across pauses
    rec.interimResults = true;    // show partials as the user speaks
    rec.lang = 'en-US';
    return rec;
  }

  /** Format a duration in ms as M:SS. */
  function formatDuration(ms) {
    const total = Math.max(0, Math.floor(ms / 1000));
    const m = Math.floor(total / 60);
    const s = total % 60;
    return m + ':' + String(s).padStart(2, '0');
  }

  /** Toggle the timer + status copy depending on recording state. */
  function setRecorderState(state) {
    const rec = document.getElementById('cap-voice-rec');
    const statusEl = document.getElementById('cap-voice-status');
    if (rec) rec.dataset.state = state;
    if (statusEl) {
      statusEl.textContent =
        state === 'recording' ? 'Recording — tap to stop'
        : state === 'denied'  ? 'Mic permission denied'
        : state === 'unsupported' ? 'Speech API unavailable'
                                : 'Tap to start';
    }
  }

  /** Repaint the transcript textarea from final + interim text. */
  function paintTranscript() {
    const ta = /** @type {HTMLTextAreaElement|null} */ (document.getElementById('cap-voice-transcript'));
    if (!ta) return;
    const interim = voiceState.interimText ? (voiceState.finalText ? ' ' : '') + voiceState.interimText : '';
    ta.value = voiceState.finalText + interim;
    // Keep the caret at the end so new words stay visible.
    try { ta.scrollTop = ta.scrollHeight; } catch (_) { /* non-fatal */ }
  }

  /** Begin a new recording session, replacing any prior transcript. */
  function startRecording() {
    if (voiceState.recognition) return;

    const rec = buildRecognition();
    if (!rec) {
      setRecorderState('unsupported');
      toast('Voice transcription not supported in this browser');
      return;
    }

    voiceState.finalText = '';
    voiceState.interimText = '';
    paintTranscript();

    rec.onresult = (ev) => {
      let interim = '';
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const r = ev.results[i];
        const text = (r[0] && r[0].transcript) || '';
        if (r.isFinal) {
          voiceState.finalText = (voiceState.finalText
            ? voiceState.finalText + ' '
            : '') + text.trim();
        } else {
          interim += text;
        }
      }
      voiceState.interimText = interim.trim();
      paintTranscript();
    };

    rec.onerror = (ev) => {
      console.warn('SpeechRecognition error:', ev.error);
      if (ev.error === 'not-allowed' || ev.error === 'service-not-allowed') {
        setRecorderState('denied');
        toast('Mic permission was denied');
      }
    };

    rec.onend = () => {
      // The recognizer can stop on its own (silence timeout). We treat
      // any "ended" state as "not recording" and surface that in the UI.
      voiceState.recognition = null;
      stopTimer();
      setRecorderState('idle');
      // Fold any pending interim text into final so the user can edit it.
      if (voiceState.interimText) {
        voiceState.finalText = (voiceState.finalText
          ? voiceState.finalText + ' '
          : '') + voiceState.interimText;
        voiceState.interimText = '';
        paintTranscript();
      }
    };

    try {
      rec.start();
    } catch (err) {
      console.warn('rec.start failed:', err);
      toast('Could not start recording');
      return;
    }

    voiceState.recognition = rec;
    voiceState.startedAt = Date.now();
    setRecorderState('recording');
    startTimer();
  }

  /** Stop the active SpeechRecognition session, if any. */
  function stopRecording() {
    const rec = voiceState.recognition;
    if (!rec) return;
    try { rec.stop(); } catch (_) { /* non-fatal */ }
    // The 'onend' handler above resets state + UI.
  }

  function startTimer() {
    stopTimer();
    const tick = () => {
      if (!voiceState.startedAt) return;
      const el = document.getElementById('cap-voice-timer');
      if (el) el.textContent = formatDuration(Date.now() - voiceState.startedAt);
    };
    tick();
    voiceState.timerId = window.setInterval(tick, 250);
  }
  function stopTimer() {
    if (voiceState.timerId) window.clearInterval(voiceState.timerId);
    voiceState.timerId = null;
  }

  /** Mic button click — toggles between start and stop. */
  function onVoiceToggleRec() {
    if (voiceState.recognition) stopRecording();
    else startRecording();
  }

  /** Throw away in-progress voice state and reset the UI. */
  function discardVoice() {
    stopRecording();
    voiceState.finalText = '';
    voiceState.interimText = '';
    voiceState.startedAt = null;
    paintTranscript();
    const el = document.getElementById('cap-voice-timer');
    if (el) el.textContent = '0:00';
    setRecorderState('idle');
    showScreen('home');
  }

  /**
   * Send the transcript to chs-claude-proxy for category + tasks
   * extraction. Returns null if Claude is unreachable or returns
   * malformed JSON; callers fall back to a raw save in that case.
   *
   * Mirrors the existing `dashboard/notes.html` flow so the dashboard's
   * notes list renders in exactly the same shape.
   */
  async function callClaudeForNote(rawText, noteCategoryHint) {
    const today = new Date().toISOString().split('T')[0];
    const sys =
      'You are a business assistant for Columbus Home Solutions. Analyze notes and return ONLY a JSON object with no other text:\n' +
      '{\n' +
      '  "summary": "2-3 sentence summary",\n' +
      '  "tags": ["tag1","tag2"],\n' +
      '  "tasks": [\n' +
      '    {"title":"task","due":"YYYY-MM-DD or null","priority":"high|med|low","category":"Job|Admin|Finance|Follow Up|Marketing|Personal"}\n' +
      '  ]\n' +
      '}\n' +
      'For due dates: "today" = ' + today + '. Infer reasonable due dates from context. Return [] for tasks if none found.';

    const res = await fetch(CLAUDE_PROXY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1000,
        system: sys,
        messages: [{
          role: 'user',
          content: 'Note category: ' + (noteCategoryHint || 'General') + '\n\nNote:\n' + rawText,
        }],
      }),
    });
    if (!res.ok) throw new Error('Claude HTTP ' + res.status);
    const data = await res.json();
    const raw = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
    const parsed = JSON.parse(raw.replace(/```json|```/g, '').trim());
    return {
      summary: parsed.summary || null,
      tags: Array.isArray(parsed.tags) ? parsed.tags : [],
      tasks: Array.isArray(parsed.tasks) ? parsed.tasks : [],
    };
  }

  /**
   * Save the current transcript as a /api/notes row. `useClaude` controls
   * whether we round-trip through the proxy for categorisation first.
   */
  async function saveVoiceNote(useClaude) {
    if (voiceState.saving) return;

    // If the user is still recording, finalize first so any interim
    // text lands in the textarea before we read it back.
    if (voiceState.recognition) {
      stopRecording();
      // Give onend a tick to flush interim → final.
      await new Promise((r) => setTimeout(r, 60));
    }

    const ta = /** @type {HTMLTextAreaElement|null} */ (document.getElementById('cap-voice-transcript'));
    const text = (ta?.value || '').trim();
    if (!text) {
      toast('Nothing to save — record or type a transcript first');
      return;
    }

    voiceState.saving = true;
    const claudeBtn = document.getElementById('cap-voice-save-claude');
    const rawBtn = document.getElementById('cap-voice-save-raw');
    const claudeTitle = document.getElementById('cap-voice-save-claude-title');
    const rawTitle = document.getElementById('cap-voice-save-raw-title');
    if (claudeBtn) claudeBtn.setAttribute('disabled', 'true');
    if (rawBtn) rawBtn.setAttribute('disabled', 'true');

    const targetIsJob = voiceState.target === 'job' && !!currentJob.id;
    const job_id = targetIsJob ? currentJob.id : null;
    const categoryHint = targetIsJob ? 'Job' : 'General';

    let summary = null;
    let tags = [];
    let tasks = [];
    let category = categoryHint;

    if (useClaude) {
      if (claudeTitle) claudeTitle.textContent = 'Asking Claude…';
      try {
        const out = await callClaudeForNote(text, categoryHint);
        if (out) {
          summary = out.summary;
          tags = out.tags;
          tasks = out.tasks;
        }
      } catch (err) {
        console.warn('Claude call failed, saving raw:', err);
        toast('Claude unavailable — saving raw');
      }
    }

    if (claudeTitle) claudeTitle.textContent = 'Saving…';
    if (rawTitle) rawTitle.textContent = 'Saving…';

    try {
      const res = await fetch(NOTES_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          category,
          raw_text: text,
          summary,
          tags,
          tasks_extracted: tasks,
          task_count: tasks.length,
          job_id,
        }),
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);

      // Success — wipe state and bounce home.
      voiceState.finalText = '';
      voiceState.interimText = '';
      voiceState.startedAt = null;
      paintTranscript();
      const t = document.getElementById('cap-voice-timer');
      if (t) t.textContent = '0:00';
      setRecorderState('idle');
      showScreen('home');
      toast(targetIsJob ? 'Voice note saved to job' : 'Voice note saved (general)');
    } catch (err) {
      console.error('Note save failed:', err);
      const enqueued = await tryEnqueueNote({
        category, raw_text: text, summary, tags,
        tasks_extracted: tasks, task_count: tasks.length, job_id,
      });
      if (enqueued) {
        voiceState.finalText = '';
        voiceState.interimText = '';
        voiceState.startedAt = null;
        paintTranscript();
        const t = document.getElementById('cap-voice-timer');
        if (t) t.textContent = '0:00';
        setRecorderState('idle');
        showScreen('home');
        toast('Saved offline — will sync when reconnected');
        refreshPendingBadge();
      } else {
        toast('Save failed — try again');
      }
    } finally {
      voiceState.saving = false;
      if (claudeBtn) claudeBtn.removeAttribute('disabled');
      if (rawBtn) rawBtn.removeAttribute('disabled');
      if (claudeTitle) claudeTitle.textContent = 'Save with Claude';
      if (rawTitle) rawTitle.textContent = 'Save raw';
    }
  }

  // ── Offline queue (Phase 5) ──────────────────────────────────────

  /** Reference to the shared queue module; null if it failed to load. */
  function queue() {
    return /** @type {any} */ (window).CHSQueue || null;
  }

  /**
   * Convert a pending photo into a queue item and persist it. Returns
   * true on success, false if IDB is unavailable (private mode, etc.).
   */
  async function tryEnqueuePhoto(metadata) {
    const q = queue();
    if (!q || !pendingPhoto || !pendingPhoto.original || !pendingPhoto.thumb) return false;
    try {
      await q.add('photo', {
        metadata,
        original: pendingPhoto.original,
        thumb: pendingPhoto.thumb,
        filename: suggestedFilename(pendingPhoto.original),
      });
      await registerSyncTag();
      return true;
    } catch (err) {
      console.warn('Photo enqueue failed:', err);
      return false;
    }
  }

  /** Same idea as tryEnqueuePhoto but for the JSON note body. */
  async function tryEnqueueNote(body) {
    const q = queue();
    if (!q) return false;
    try {
      await q.add('note', { body });
      await registerSyncTag();
      return true;
    } catch (err) {
      console.warn('Note enqueue failed:', err);
      return false;
    }
  }

  /**
   * Ask the OS to call our service worker once connectivity returns.
   * Best-effort: Safari and Firefox don't ship Background Sync; we
   * fall back to draining on the page's `online` event + SW message
   * channel for those cases.
   */
  async function registerSyncTag() {
    try {
      const reg = await navigator.serviceWorker?.ready;
      if (reg && 'sync' in reg) {
        await /** @type {any} */ (reg).sync.register('chs-capture-drain');
      }
    } catch (_) { /* non-fatal */ }
  }

  /** Poke the active SW to drain right now (iOS Safari fallback). */
  function requestServiceWorkerDrain() {
    try {
      navigator.serviceWorker?.controller?.postMessage({ type: 'drain' });
    } catch (_) { /* non-fatal */ }
  }

  /**
   * Drain the queue from the page itself. We do this whenever the
   * browser tells us we're online, the user lands on the Pending
   * screen, or the user taps "Retry now". The SW also drains via
   * Background Sync when supported; both paths are idempotent.
   */
  let drainInflight = false;
  async function drainFromPage(reason) {
    const q = queue();
    if (!q || drainInflight) return;
    drainInflight = true;
    try {
      const res = await q.drain();
      if (res && res.ok > 0) {
        toast('Synced ' + res.ok + ' pending ' + (res.ok === 1 ? 'item' : 'items'));
      }
    } catch (err) {
      console.warn('Page drain failed:', err);
    } finally {
      drainInflight = false;
      refreshPendingBadge();
      if (document.querySelector('.cap-screen[data-screen="pending"][data-active="true"]')) {
        renderPendingList();
      }
    }
  }

  /** Refresh the "N" badge on the Home Pending tile + top-bar icon. */
  async function refreshPendingBadge() {
    const q = queue();
    const badge = document.getElementById('cap-pending-count');
    if (!badge) return;
    if (!q) { badge.dataset.count = '0'; badge.textContent = '0'; return; }
    try {
      const n = await q.count();
      badge.dataset.count = String(n);
      badge.textContent = String(n);
    } catch (_) {
      badge.dataset.count = '0';
    }
  }

  /** Paint the Pending screen list from the queue contents. */
  async function renderPendingList() {
    const list = document.getElementById('cap-pending-list');
    const q = queue();
    if (!list) return;
    if (!q) {
      list.innerHTML = '<div class="cap-pending-empty">Offline storage unavailable in this browser.</div>';
      return;
    }

    let items = [];
    try { items = await q.list(); }
    catch (err) {
      list.innerHTML = '<div class="cap-pending-empty">Could not read queue: ' + escapeHtml(err.message || String(err)) + '</div>';
      return;
    }

    if (items.length === 0) {
      list.innerHTML = '<div class="cap-pending-empty">Nothing pending. Captures will appear here only when offline.</div>';
      return;
    }

    list.innerHTML = items.map((it) => {
      const when = it.created_at ? formatRelative(it.created_at) : '';
      const meta = it.kind === 'photo'
        ? describePhotoItem(it)
        : describeNoteItem(it);
      const failed = (it.attempts || 0) > 0;
      return `
        <div class="cap-pending-row" data-failed="${failed ? 'true' : 'false'}">
          <div class="cap-pending-row-head">
            <span>${it.kind === 'photo' ? '📷 PHOTO' : '🎙️ NOTE'}</span>
            <span>${escapeHtml(when)}</span>
          </div>
          <div class="cap-pending-row-meta">${escapeHtml(meta)}</div>
          ${failed ? `<div class="cap-pending-row-error">Attempt ${it.attempts}: ${escapeHtml(it.last_error || 'failed')}</div>` : ''}
        </div>`;
    }).join('');
  }

  function describePhotoItem(it) {
    const m = (it.payload && it.payload.metadata) || {};
    const job = m.job_id ? 'Job ' + m.job_id : 'General';
    const cat = (m.category || 'progress').toString();
    return `${job} · ${cat}`;
  }
  function describeNoteItem(it) {
    const b = (it.payload && it.payload.body) || {};
    const job = b.job_id ? 'Job ' + b.job_id : 'General';
    const snippet = (b.raw_text || '').slice(0, 60);
    return `${job}${snippet ? ' · ' + snippet : ''}`;
  }
  function formatRelative(iso) {
    const t = Date.parse(iso);
    if (Number.isNaN(t)) return '';
    const diff = Date.now() - t;
    const sec = Math.round(diff / 1000);
    if (sec < 60) return sec + 's ago';
    const min = Math.round(sec / 60);
    if (min < 60) return min + 'm ago';
    const hr = Math.round(min / 60);
    if (hr < 24) return hr + 'h ago';
    return Math.round(hr / 24) + 'd ago';
  }

  /** Pick a sensible filename for the original. Cameras don't always set one. */
  function suggestedFilename(file) {
    if (file.name && file.name !== 'image.jpg') return file.name;
    const ext = (file.type === 'image/png') ? 'png'
              : (file.type === 'image/heic' || file.type === 'image/heif') ? 'heic'
              : 'jpg';
    return `capture-${Date.now()}.${ext}`;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }
  function escapeAttr(s) { return escapeHtml(s); }

  /** Single delegated click handler — covers nav buttons + action buttons + job rows + category tiles. */
  function onClick(e) {
    const el = e.target instanceof Element ? e.target : null;
    if (!el) return;

    // Category tiles take precedence over the generic data-action handler.
    const cat = el.closest('#cap-cat-grid .cap-cat');
    if (cat) { onCategoryClick(cat); return; }

    // Voice job/general toggle (also takes precedence so the toggle
    // buttons don't accidentally match a stray data-action selector).
    const voiceTab = el.closest('.cap-voice-toggle-btn');
    if (voiceTab) { setVoiceTarget(voiceTab.dataset.voiceTarget); return; }

    const target = el.closest('[data-action], .cap-jobrow');
    if (!target) return;

    if (target.classList.contains('cap-jobrow')) {
      selectJob(
        target.dataset.jobId || '',
        target.dataset.jobTitle || '',
        target.dataset.jobMeta || '',
      );
      return;
    }

    const action = target.dataset.action;
    switch (action) {
      case 'goto-home':         showScreen('home'); break;
      case 'goto-camera':       showScreen('camera'); break;
      case 'goto-voice':        showScreen('voice'); break;
      case 'goto-switch-job':   showScreen('switch-job'); break;
      case 'goto-pending':      showScreen('pending'); break;
      case 'open-camera':       openCamera(); break;
      case 'submit-photo':      submitPendingPhoto(); break;
      case 'discard-photo':     discardPendingPhoto(); break;
      case 'voice-toggle-rec':  onVoiceToggleRec(); break;
      case 'voice-discard':     discardVoice(); break;
      case 'voice-save-claude': saveVoiceNote(true); break;
      case 'voice-save-raw':    saveVoiceNote(false); break;
      case 'pending-retry':     drainFromPage('manual'); break;
    }
  }

  function onSearchInput(e) { renderJobList(e.target.value); }

  /** Honor ?screen=foo at load time so the manifest shortcuts can deep-link. */
  function applyDeepLink() {
    const params = new URLSearchParams(location.search);
    const screen = params.get('screen');
    const allowed = ['home', 'camera', 'voice', 'switch-job', 'pending'];
    if (screen && allowed.includes(screen)) showScreen(screen);
  }

  /**
   * Register the capture-scoped service worker and listen for drain
   * results. Phase 5 ships a real SW that reacts to background sync;
   * we still also drain from the page on `online` events for browsers
   * (notably iOS Safari) that don't implement Background Sync.
   */
  function registerSW() {
    if (!('serviceWorker' in navigator)) return;
    navigator.serviceWorker.register('sw.js', { scope: '/capture/' })
      .catch((err) => console.warn('SW registration failed:', err));

    navigator.serviceWorker.addEventListener('message', (ev) => {
      const data = ev.data || {};
      if (data.type !== 'drain-result') return;
      if (data.ok > 0) {
        toast('Synced ' + data.ok + ' pending ' + (data.ok === 1 ? 'item' : 'items'));
      }
      refreshPendingBadge();
      if (document.querySelector('.cap-screen[data-screen="pending"][data-active="true"]')) {
        renderPendingList();
      }
    });
  }

  /**
   * Whenever the browser thinks we're back online, ask both the page
   * and the SW to drain. The two paths are idempotent — whichever
   * runs first removes its items and the other no-ops.
   */
  function bindConnectivityHandlers() {
    window.addEventListener('online', () => {
      drainFromPage('online-event');
      requestServiceWorkerDrain();
    });
    // Returning to the foreground on iOS doesn't always fire 'online'
    // even if connectivity returned in the background; piggy-back on
    // visibility changes too.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && navigator.onLine) {
        drainFromPage('visibility');
        requestServiceWorkerDrain();
      }
    });
  }

  // ── boot ──────────────────────────────────────────────────────────
  document.addEventListener('click', onClick);
  document.getElementById('cap-job-search')?.addEventListener('input', onSearchInput);
  document.getElementById('cap-camera-input')?.addEventListener('change', onCameraInput);
  renderCurrentJob();
  applyDeepLink();
  registerSW();
  bindConnectivityHandlers();
  refreshPendingBadge();
  // If we boot up online with stale items still in IDB, give them a try.
  if (navigator.onLine) drainFromPage('boot');
})();
