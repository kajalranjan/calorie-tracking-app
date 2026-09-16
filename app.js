'use strict';

/* =========================================================================
   Calorie Tracker — local-only, phone-first calorie tracker
   Data lives entirely in this browser (IndexedDB). Nothing is sent anywhere
   except: when you use AI estimation, your description/photo/grams are sent
   directly to Google's Gemini API using your own API key.
   ========================================================================= */

// ---------------------------------------------------------------------
// IndexedDB helper
// ---------------------------------------------------------------------
const DB_NAME = 'calorieTrackerDB';
const DB_VERSION = 1;
let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('entries')) {
        const store = db.createObjectStore('entries', { keyPath: 'id' });
        store.createIndex('date', 'date', { unique: false });
      }
      if (!db.objectStoreNames.contains('settings')) {
        db.createObjectStore('settings', { keyPath: 'key' });
      }
    };
    req.onsuccess = (e) => resolve(e.target.result);
    req.onerror = (e) => reject(e.target.error);
  });
  return dbPromise;
}

function tx(storeName, mode) {
  return openDB().then((db) => db.transaction(storeName, mode).objectStore(storeName));
}

async function dbGetAllEntries() {
  const store = await tx('entries', 'readonly');
  return new Promise((resolve, reject) => {
    const req = store.getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

async function dbPutEntry(entry) {
  const store = await tx('entries', 'readwrite');
  return new Promise((resolve, reject) => {
    const req = store.put(entry);
    req.onsuccess = () => resolve(entry);
    req.onerror = () => reject(req.error);
  });
}

async function dbDeleteEntry(id) {
  const store = await tx('entries', 'readwrite');
  return new Promise((resolve, reject) => {
    const req = store.delete(id);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

async function dbGetSetting(key, defaultValue) {
  const store = await tx('settings', 'readonly');
  return new Promise((resolve, reject) => {
    const req = store.get(key);
    req.onsuccess = () => resolve(req.result ? req.result.value : defaultValue);
    req.onerror = () => reject(req.error);
  });
}

async function dbSetSetting(key, value) {
  const store = await tx('settings', 'readwrite');
  return new Promise((resolve, reject) => {
    const req = store.put({ key, value });
    req.onsuccess = () => resolve(value);
    req.onerror = () => reject(req.error);
  });
}

// ---------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------
function uid() {
  if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
  return 'id-' + Date.now() + '-' + Math.random().toString(16).slice(2);
}

function getLocalDateString(d = new Date()) {
  const offset = d.getTimezoneOffset();
  const local = new Date(d.getTime() - offset * 60000);
  return local.toISOString().slice(0, 10);
}

function formatDateLabel(dateStr) {
  const today = getLocalDateString();
  const yesterday = getLocalDateString(new Date(Date.now() - 86400000));
  if (dateStr === today) return 'Today';
  if (dateStr === yesterday) return 'Yesterday';
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str == null ? '' : String(str);
  return div.innerHTML;
}

function showToast(message, ms = 2800) {
  const toast = document.getElementById('toast');
  toast.textContent = message;
  toast.classList.remove('hidden');
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => toast.classList.add('hidden'), ms);
}

function openModal(id) { document.getElementById(id).classList.remove('hidden'); }
function closeModal(id) { document.getElementById(id).classList.add('hidden'); }

// ---------------------------------------------------------------------
// Image compression (resize + re-encode as JPEG)
// ---------------------------------------------------------------------
function compressImageFile(file, maxDim = 900, quality = 0.72) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = (e) => {
      const img = new Image();
      img.onerror = () => reject(new Error('Could not read image'));
      img.onload = () => {
        let { width, height } = img;
        if (width > maxDim || height > maxDim) {
          if (width >= height) {
            height = Math.round(height * (maxDim / width));
            width = maxDim;
          } else {
            width = Math.round(width * (maxDim / height));
            height = maxDim;
          }
        }
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL('image/jpeg', quality));
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  });
}

// ---------------------------------------------------------------------
// Gemini API call
// ---------------------------------------------------------------------
async function estimateCaloriesWithAI({ description, grams, photoDataUrl }) {
  const apiKey = await dbGetSetting('geminiApiKey', '');
  const model = (await dbGetSetting('geminiModel', 'gemini-2.0-flash')) || 'gemini-2.0-flash';

  if (!apiKey) {
    const err = new Error('No Gemini API key set. Open Settings to add your free API key.');
    err.code = 'NO_API_KEY';
    throw err;
  }

  let prompt = 'You are a careful, realistic nutrition estimator helping someone log a meal they ate.\n\n';
  prompt += `Food description (from the person): ${description}\n`;
  if (grams) prompt += `Reported total weight: ${grams} grams.\n`;
  if (photoDataUrl) {
    prompt += 'A photo of the meal is attached — use it together with the description to judge portion size and ingredients. ';
    prompt += 'If a coin or other common object of a known, standard size (e.g. a coin, a utensil, a credit card) is visible next to the food, use it as a scale reference to more precisely judge the real-world size/volume of the food items, and factor that into your portion and calorie estimate.\n';
  }
  prompt += '\nEstimate the nutrition for the WHOLE described portion (not per 100g). ';
  prompt += 'Respond with ONLY a raw JSON object, no markdown fences, no extra commentary, in exactly this shape:\n';
  prompt += '{"calories": number, "protein_g": number, "carbs_g": number, "fat_g": number, "confidence": "low" | "medium" | "high", "notes": "one short sentence explaining your reasoning"}';

  const parts = [{ text: prompt }];
  if (photoDataUrl) {
    const base64 = photoDataUrl.split(',')[1];
    parts.push({ inline_data: { mime_type: 'image/jpeg', data: base64 } });
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const body = {
    contents: [{ parts }],
    generationConfig: { responseMimeType: 'application/json', temperature: 0.2 }
  };

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
  } catch (networkErr) {
    const err = new Error('Network error reaching Gemini. Check your connection and try again.');
    err.code = 'NETWORK_ERROR';
    throw err;
  }

  if (!res.ok) {
    let detail = '';
    try {
      const errJson = await res.json();
      detail = errJson?.error?.message || '';
    } catch (_) { /* ignore */ }
    const err = new Error(`Gemini API error (${res.status}). ${detail}`.trim());
    err.code = 'API_ERROR';
    err.status = res.status;
    throw err;
  }

  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) {
    const err = new Error('Gemini returned an empty response. Try again.');
    err.code = 'EMPTY_RESPONSE';
    throw err;
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (_) {
    const match = text.match(/\{[\s\S]*\}/);
    if (match) {
      try { parsed = JSON.parse(match[0]); } catch (_) { /* fallthrough */ }
    }
  }

  if (!parsed || typeof parsed.calories !== 'number' || Number.isNaN(parsed.calories)) {
    const err = new Error("Couldn't parse Gemini's answer. Try rewording your description, or enter calories manually.");
    err.code = 'PARSE_ERROR';
    throw err;
  }

  return {
    calories: Math.round(parsed.calories),
    protein_g: typeof parsed.protein_g === 'number' ? Math.round(parsed.protein_g) : null,
    carbs_g: typeof parsed.carbs_g === 'number' ? Math.round(parsed.carbs_g) : null,
    fat_g: typeof parsed.fat_g === 'number' ? Math.round(parsed.fat_g) : null,
    confidence: ['low', 'medium', 'high'].includes(parsed.confidence) ? parsed.confidence : null,
    notes: typeof parsed.notes === 'string' ? parsed.notes : ''
  };
}

// ---------------------------------------------------------------------
// App state
// ---------------------------------------------------------------------
const state = {
  entries: [],
  goal: 2000,
  editingEntryId: null,
  pendingPhotoDataUrl: null
};

// ---------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------
function entriesForDate(dateStr) {
  return state.entries
    .filter((e) => e.date === dateStr)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function totalForDate(dateStr) {
  return entriesForDate(dateStr).reduce((sum, e) => sum + (e.calories || 0), 0);
}

function renderHome() {
  const today = getLocalDateString();
  document.getElementById('todayLabel').textContent = new Date().toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

  const total = totalForDate(today);
  const goal = state.goal || 0;
  document.getElementById('totalCalories').textContent = total;
  document.getElementById('goalCalories').textContent = goal;

  const pct = goal > 0 ? Math.min(100, Math.round((total / goal) * 100)) : 0;
  const fill = document.getElementById('progressFill');
  fill.style.width = pct + '%';
  fill.classList.toggle('over-goal', goal > 0 && total > goal);

  const remainingEl = document.getElementById('remainingText');
  if (goal > 0) {
    const remaining = goal - total;
    remainingEl.textContent = remaining >= 0
      ? `${remaining} kcal remaining today`
      : `${Math.abs(remaining)} kcal over your goal`;
  } else {
    remainingEl.textContent = 'Set a daily goal to track progress';
  }

  const list = document.getElementById('todayList');
  const empty = document.getElementById('emptyToday');
  const todays = entriesForDate(today);

  if (todays.length === 0) {
    list.innerHTML = '';
    empty.classList.remove('hidden');
  } else {
    empty.classList.add('hidden');
    list.innerHTML = todays.map((e) => renderEntryCard(e)).join('');
  }
}

function renderEntryCard(entry) {
  const thumb = entry.photo
    ? `<img class="entry-thumb" src="${entry.photo}" alt="Meal photo">`
    : `<div class="entry-thumb-placeholder">🍽️</div>`;

  const metaParts = [];
  if (entry.grams) metaParts.push(`${entry.grams}g`);
  metaParts.push(entry.source === 'ai' ? 'AI estimate' : 'Manual');
  if (entry.aiConfidence) metaParts.push(`${entry.aiConfidence} confidence`);

  return `
    <div class="entry-card" data-id="${entry.id}">
      ${thumb}
      <div class="entry-main">
        <div class="entry-desc">${escapeHtml(entry.description)}</div>
        <div class="entry-meta">${escapeHtml(metaParts.join(' · '))}</div>
      </div>
      <div class="entry-cal">${entry.calories}<small>kcal</small></div>
      <div class="entry-actions">
        <button class="edit-entry-btn" data-id="${entry.id}" aria-label="Edit">✏️</button>
        <button class="delete-entry-btn" data-id="${entry.id}" aria-label="Delete">🗑️</button>
      </div>
    </div>`;
}

function renderLog() {
  const container = document.getElementById('logContent');
  if (state.entries.length === 0) {
    container.innerHTML = '<div class="log-empty">Nothing logged yet. Your entries will show up here.</div>';
    return;
  }

  const dates = [...new Set(state.entries.map((e) => e.date))].sort((a, b) => b.localeCompare(a));

  container.innerHTML = dates.map((date) => {
    const dayEntries = entriesForDate(date);
    const dayTotal = totalForDate(date);
    return `
      <div class="log-day">
        <div class="log-day-header">
          <span class="log-day-title">${formatDateLabel(date)}</span>
          <span class="log-day-total">${dayTotal} kcal${state.goal ? ' / ' + state.goal : ''}</span>
        </div>
        <div class="entry-list">
          ${dayEntries.map((e) => renderEntryCard(e)).join('')}
        </div>
      </div>`;
  }).join('');
}

// ---------------------------------------------------------------------
// Entry modal logic
// ---------------------------------------------------------------------
function resetEntryForm() {
  state.editingEntryId = null;
  state.pendingPhotoDataUrl = null;
  document.getElementById('entryModalTitle').textContent = 'Log Meal';
  document.getElementById('descriptionInput').value = '';
  document.getElementById('gramsInput').value = '';
  document.getElementById('manualCaloriesInput').value = '';
  document.getElementById('photoInput').value = '';
  document.getElementById('photoPreview').classList.add('hidden');
  document.getElementById('photoPreview').src = '';
  document.getElementById('removePhotoBtn').classList.add('hidden');
  const aiStatus = document.getElementById('aiStatus');
  aiStatus.classList.add('hidden');
  aiStatus.classList.remove('error');
  document.getElementById('aiResultSummary').classList.add('hidden');
  const submitBtn = document.getElementById('submitEntryBtn');
  submitBtn.disabled = false;
  submitBtn.textContent = 'Calculate & Log';
}

function openNewEntryModal() {
  resetEntryForm();
  openModal('entryModal');
}

function openEditEntryModal(entryId) {
  const entry = state.entries.find((e) => e.id === entryId);
  if (!entry) return;
  resetEntryForm();
  state.editingEntryId = entryId;
  document.getElementById('entryModalTitle').textContent = 'Edit Meal';
  document.getElementById('descriptionInput').value = entry.description || '';
  document.getElementById('gramsInput').value = entry.grams || '';
  document.getElementById('manualCaloriesInput').value = entry.calories || '';
  if (entry.photo) {
    state.pendingPhotoDataUrl = entry.photo;
    const preview = document.getElementById('photoPreview');
    preview.src = entry.photo;
    preview.classList.remove('hidden');
    document.getElementById('removePhotoBtn').classList.remove('hidden');
  }
  document.getElementById('submitEntryBtn').textContent = 'Save Changes';
  openModal('entryModal');
}

async function handlePhotoSelected(file) {
  if (!file) return;
  try {
    const dataUrl = await compressImageFile(file);
    state.pendingPhotoDataUrl = dataUrl;
    const preview = document.getElementById('photoPreview');
    preview.src = dataUrl;
    preview.classList.remove('hidden');
    document.getElementById('removePhotoBtn').classList.remove('hidden');
  } catch (err) {
    showToast('Could not read that photo. Try another one.');
  }
}

async function handleSubmitEntry() {
  const description = document.getElementById('descriptionInput').value.trim();
  const gramsRaw = document.getElementById('gramsInput').value;
  const manualRaw = document.getElementById('manualCaloriesInput').value;

  if (!description) {
    showToast('Please describe what you ate first.');
    document.getElementById('descriptionInput').focus();
    return;
  }

  const grams = gramsRaw ? Number(gramsRaw) : null;
  const manualCalories = manualRaw !== '' ? Number(manualRaw) : null;

  const submitBtn = document.getElementById('submitEntryBtn');
  const aiStatus = document.getElementById('aiStatus');
  const aiResult = document.getElementById('aiResultSummary');
  aiResult.classList.add('hidden');

  let finalCalories, source, macros = null, aiConfidence = null, aiNotes = '';

  if (manualCalories !== null && !Number.isNaN(manualCalories)) {
    finalCalories = Math.round(manualCalories);
    source = 'manual';
  } else {
    submitBtn.disabled = true;
    submitBtn.textContent = 'Estimating with AI…';
    aiStatus.classList.remove('hidden', 'error');
    aiStatus.textContent = 'Asking Gemini to estimate calories…';

    try {
      const result = await estimateCaloriesWithAI({
        description,
        grams,
        photoDataUrl: state.pendingPhotoDataUrl
      });
      finalCalories = result.calories;
      source = 'ai';
      macros = { protein_g: result.protein_g, carbs_g: result.carbs_g, fat_g: result.fat_g };
      aiConfidence = result.confidence;
      aiNotes = result.notes;

      aiStatus.classList.add('hidden');
      aiResult.classList.remove('hidden');
      aiResult.innerHTML = `<strong>${finalCalories} kcal</strong> estimated` +
        (macros.protein_g != null ? ` · P ${macros.protein_g}g / C ${macros.carbs_g}g / F ${macros.fat_g}g` : '') +
        (aiConfidence ? ` · ${aiConfidence} confidence` : '') +
        (aiNotes ? `<br>${escapeHtml(aiNotes)}` : '');
    } catch (err) {
      submitBtn.disabled = false;
      submitBtn.textContent = state.editingEntryId ? 'Save Changes' : 'Calculate & Log';
      aiStatus.classList.remove('hidden');
      aiStatus.classList.add('error');
      aiStatus.textContent = err.message || 'Something went wrong estimating calories.';
      if (err.code === 'NO_API_KEY') {
        setTimeout(() => { closeModal('entryModal'); openSettingsModal(); }, 900);
      }
      return;
    }
  }

  const now = new Date();
  const entry = {
    id: state.editingEntryId || uid(),
    date: state.editingEntryId
      ? state.entries.find((e) => e.id === state.editingEntryId).date
      : getLocalDateString(now),
    createdAt: state.editingEntryId
      ? state.entries.find((e) => e.id === state.editingEntryId).createdAt
      : now.toISOString(),
    updatedAt: now.toISOString(),
    description,
    grams,
    calories: finalCalories,
    source,
    macros,
    aiConfidence,
    aiNotes,
    photo: state.pendingPhotoDataUrl || null
  };

  await dbPutEntry(entry);
  const idx = state.entries.findIndex((e) => e.id === entry.id);
  if (idx >= 0) state.entries[idx] = entry; else state.entries.push(entry);

  closeModal('entryModal');
  renderHome();
  renderLog();
  showToast(state.editingEntryId ? 'Entry updated' : `Logged ${finalCalories} kcal`);
}

async function handleDeleteEntry(entryId) {
  if (!confirm('Delete this entry? This cannot be undone.')) return;
  await dbDeleteEntry(entryId);
  state.entries = state.entries.filter((e) => e.id !== entryId);
  renderHome();
  renderLog();
  showToast('Entry deleted');
}

// ---------------------------------------------------------------------
// Goal modal
// ---------------------------------------------------------------------
function openGoalModal(isFirstRun = false) {
  document.getElementById('goalInput').value = state.goal || '';
  document.getElementById('goalModalTitle').textContent = isFirstRun
    ? 'Welcome! Set your daily calorie goal'
    : 'Edit Daily Calorie Goal';
  const closeBtn = document.querySelector('#goalModal .close-btn');
  closeBtn.style.visibility = isFirstRun ? 'hidden' : 'visible';
  openModal('goalModal');
}

async function handleSaveGoal() {
  const val = Number(document.getElementById('goalInput').value);
  if (!val || val <= 0) {
    showToast('Please enter a goal greater than 0.');
    return;
  }
  state.goal = Math.round(val);
  await dbSetSetting('dailyGoal', state.goal);
  closeModal('goalModal');
  renderHome();
  showToast('Goal saved');
}

// ---------------------------------------------------------------------
// Settings modal
// ---------------------------------------------------------------------
async function openSettingsModal() {
  document.getElementById('apiKeyInput').value = await dbGetSetting('geminiApiKey', '');
  document.getElementById('modelInput').value = await dbGetSetting('geminiModel', 'gemini-2.0-flash');
  openModal('settingsModal');
}

async function handleSaveSettings() {
  const apiKey = document.getElementById('apiKeyInput').value.trim();
  const model = document.getElementById('modelInput').value.trim() || 'gemini-2.0-flash';
  await dbSetSetting('geminiApiKey', apiKey);
  await dbSetSetting('geminiModel', model);
  closeModal('settingsModal');
  showToast('Settings saved');
}

// ---------------------------------------------------------------------
// Init & event wiring
// ---------------------------------------------------------------------
async function init() {
  state.entries = await dbGetAllEntries();
  const savedGoal = await dbGetSetting('dailyGoal', null);

  if (savedGoal) {
    state.goal = savedGoal;
  } else {
    state.goal = 2000;
    openGoalModal(true);
  }

  renderHome();
  renderLog();

  // Header buttons
  document.getElementById('openLogBtn').addEventListener('click', () => {
    renderLog();
    openModal('logDrawer');
  });
  document.getElementById('openSettingsBtn').addEventListener('click', openSettingsModal);
  document.getElementById('editGoalBtn').addEventListener('click', () => openGoalModal(false));

  // Close buttons
  document.querySelectorAll('[data-close]').forEach((btn) => {
    btn.addEventListener('click', () => closeModal(btn.getAttribute('data-close')));
  });

  // Entry flow
  document.getElementById('logEntryBtn').addEventListener('click', openNewEntryModal);
  document.getElementById('takePhotoBtn').addEventListener('click', () => document.getElementById('photoInput').click());
  document.getElementById('photoInput').addEventListener('change', (e) => handlePhotoSelected(e.target.files[0]));
  document.getElementById('removePhotoBtn').addEventListener('click', () => {
    state.pendingPhotoDataUrl = null;
    document.getElementById('photoPreview').classList.add('hidden');
    document.getElementById('photoInput').value = '';
    document.getElementById('removePhotoBtn').classList.add('hidden');
  });
  document.getElementById('submitEntryBtn').addEventListener('click', handleSubmitEntry);

  // Goal
  document.getElementById('saveGoalBtn').addEventListener('click', handleSaveGoal);

  // Settings
  document.getElementById('saveSettingsBtn').addEventListener('click', handleSaveSettings);

  // Delegated edit/delete (home list + log drawer)
  document.body.addEventListener('click', (e) => {
    const editBtn = e.target.closest('.edit-entry-btn');
    if (editBtn) {
      closeModal('logDrawer');
      openEditEntryModal(editBtn.getAttribute('data-id'));
      return;
    }
    const delBtn = e.target.closest('.delete-entry-btn');
    if (delBtn) {
      handleDeleteEntry(delBtn.getAttribute('data-id'));
    }
  });
}

document.addEventListener('DOMContentLoaded', init);
