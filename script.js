/* =========================================================
   ATLANTE — script.js
   App di gestione viaggi, 100% client-side (localStorage).
   ========================================================= */

(function () {
  "use strict";

  // ---------- Costanti ----------
  const STORAGE_PLACES = "atlante_places_v1";
  const STORAGE_TAGS = "atlante_tags_v1";
  const TRASH_RETENTION_DAYS = 60;
  const MAX_TAGS_PER_PLACE = 10;
  const DEFAULT_TAG_COLORS = ["#2F6D69", "#C99A3C", "#B5502F", "#5B7FB5", "#7A6BA6", "#4E8C5A"];

  // ---------- Google Drive: configurazione ----------
  // 1. Sostituisci il valore qui sotto con il TUO Client ID (vedi README.md, sezione "Sincronizzazione con Google Drive").
  const GOOGLE_CLIENT_ID = "361800686303-o2l9or0ear8hr052paean09tb9h0h6ti.apps.googleusercontent.com";
  // Scope "drive.appdata": l'app può leggere/scrivere SOLO un proprio file nascosto nel Drive
  // dell'utente, senza mai vedere o toccare gli altri file del suo Google Drive.
  const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.appdata";
  const DRIVE_FILE_NAME = "atlante-data.json";
  const SYNC_DEBOUNCE_MS = 1500;

  // ---------- Stato ----------
  let places = [];
  let tags = [];
  let selectedTagIdsInForm = [];
  let currentStatusInForm = "to_visit";
  let coverDataInForm = { type: null, value: null }; // type: 'url' | 'upload'
  let activeTagFilters = new Set();
  let editingPlaceId = null;
  let confirmCallback = null;
  let lastProximityOrigin = null; // {lat, lng, label}
  let placeDistances = {}; // id -> km

  // ---------- Stato: Google Drive ----------
  let tokenClient = null;
  let accessToken = null;
  let driveFileId = null;
  let syncDebounceTimer = null;
  let isPushing = false;
  let isPulling = false;

  // ---------- Gestione errori globale ----------
  // Se qualcosa va storto, lo mostriamo a schermo invece di far sembrare
  // che "i pulsanti non funzionano" senza alcuna spiegazione.
  window.addEventListener("error", (e) => {
    console.error("Errore JS:", e.error || e.message);
    try { showToast("Si è verificato un errore: " + (e.message || "vedi la console del browser (F12)")); } catch (_) {}
  });

  // ---------- Utilità ----------
  const $ = (id) => document.getElementById(id);
  const uid = () => "p_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

  function showToast(msg) {
    const t = $("toast");
    t.textContent = msg;
    t.classList.remove("hidden");
    clearTimeout(showToast._timer);
    showToast._timer = setTimeout(() => t.classList.add("hidden"), 2600);
  }

  function savePlaces() {
    localStorage.setItem(STORAGE_PLACES, JSON.stringify(places));
    scheduleCloudPush();
  }
  function saveTags() {
    localStorage.setItem(STORAGE_TAGS, JSON.stringify(tags));
    scheduleCloudPush();
  }
  function loadData() {
    try { places = JSON.parse(localStorage.getItem(STORAGE_PLACES)) || []; } catch (e) { places = []; }
    try { tags = JSON.parse(localStorage.getItem(STORAGE_TAGS)) || []; } catch (e) { tags = []; }
  }

  function purgeExpiredTrash() {
    const now = Date.now();
    const before = places.length;
    places = places.filter((p) => {
      if (!p.deletedAt) return true;
      const age = now - new Date(p.deletedAt).getTime();
      return age < TRASH_RETENTION_DAYS * 24 * 60 * 60 * 1000;
    });
    if (places.length !== before) savePlaces();
  }

  function tagById(id) { return tags.find((t) => t.id === id); }

  // Prova a interpretare l'indirizzo come "lat, lng"
  function tryParseCoords(str) {
    if (!str) return null;
    const m = str.trim().match(/^(-?\d+(\.\d+)?)\s*,\s*(-?\d+(\.\d+)?)$/);
    if (!m) return null;
    const lat = parseFloat(m[1]);
    const lng = parseFloat(m[3]);
    if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
    return { lat, lng };
  }

  function getPlaceCoords(place) {
    const c = tryParseCoords(place.address);
    return c;
  }

  function haversineKm(a, b) {
    const R = 6371;
    const dLat = ((b.lat - a.lat) * Math.PI) / 180;
    const dLng = ((b.lng - a.lng) * Math.PI) / 180;
    const lat1 = (a.lat * Math.PI) / 180;
    const lat2 = (b.lat * Math.PI) / 180;
    const h =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }

  async function geocode(query) {
    const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(query)}`;
    const res = await fetch(url, { headers: { "Accept": "application/json" } });
    if (!res.ok) throw new Error("Geocoding fallito");
    const data = await res.json();
    if (!data || !data.length) return null;
    return { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon) };
  }

  function googleMapsUrl(place) {
    const coords = getPlaceCoords(place);
    if (coords) {
      return `https://www.google.com/maps/search/?api=1&query=${coords.lat},${coords.lng}`;
    }
    const q = `${place.address}, ${place.country}`;
    return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}`;
  }

  // ---------- Rendering: filtri select ----------
  function renderCountryFilterOptions() {
    const sel = $("countryFilter");
    const current = sel.value;
    const countries = [...new Set(places.filter((p) => !p.deletedAt).map((p) => p.country.trim()))].sort((a, b) =>
      a.localeCompare(b, "it")
    );
    sel.innerHTML = '<option value="">Tutte le nazioni</option>' +
      countries.map((c) => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join("");
    if (countries.includes(current)) sel.value = current;
  }

  function renderTagFilterList() {
    const wrap = $("tagFilterList");
    if (!tags.length) {
      wrap.innerHTML = '<span class="field-hint">Nessun tag creato.</span>';
      return;
    }
    wrap.innerHTML = tags
      .map((t) => {
        const active = activeTagFilters.has(t.id);
        return `<button type="button" class="tag-pill-toggle ${active ? "active" : ""}" data-tag-id="${t.id}" style="${active ? `background:${t.color};border-color:${t.color};` : ""}">${escapeHtml(t.name)}</button>`;
      })
      .join("");
    wrap.querySelectorAll("[data-tag-id]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const id = btn.dataset.tagId;
        if (activeTagFilters.has(id)) activeTagFilters.delete(id);
        else activeTagFilters.add(id);
        renderTagFilterList();
        renderGrid();
      });
    });
  }

  function escapeHtml(str) {
    if (str == null) return "";
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  // ---------- Rendering: griglia principale ----------
  function getFilteredSortedPlaces() {
    const q = $("searchInput").value.trim().toLowerCase();
    const country = $("countryFilter").value;
    const status = $("statusFilter").value;
    const sortMode = $("sortSelect").value;

    let list = places.filter((p) => !p.deletedAt);

    if (q) {
      list = list.filter((p) => {
        const tagNames = (p.tags || []).map((tid) => tagById(tid)?.name || "").join(" ").toLowerCase();
        return (
          p.name.toLowerCase().includes(q) ||
          (p.description || "").toLowerCase().includes(q) ||
          p.country.toLowerCase().includes(q) ||
          tagNames.includes(q)
        );
      });
    }
    if (country) list = list.filter((p) => p.country.trim() === country);
    if (status) list = list.filter((p) => p.status === status);
    if (activeTagFilters.size) {
      list = list.filter((p) => (p.tags || []).some((tid) => activeTagFilters.has(tid)));
    }

    if (sortMode === "alpha") {
      list.sort((a, b) => a.name.localeCompare(b.name, "it"));
    } else if (sortMode === "dateDesc") {
      list.sort((a, b) => new Date(b.dateAdded) - new Date(a.dateAdded));
    } else if (sortMode === "dateAsc") {
      list.sort((a, b) => new Date(a.dateAdded) - new Date(b.dateAdded));
    } else if (sortMode === "proximity" && lastProximityOrigin) {
      list.sort((a, b) => {
        const da = placeDistances[a.id];
        const db = placeDistances[b.id];
        if (da == null && db == null) return 0;
        if (da == null) return 1;
        if (db == null) return -1;
        return da - db;
      });
    }
    return list;
  }

  function renderGrid() {
    const list = getFilteredSortedPlaces();
    const grid = $("placesGrid");
    const empty = $("emptyState");
    const info = $("resultsInfo");

    const sortMode = $("sortSelect").value;
    if (sortMode === "proximity" && !lastProximityOrigin) {
      info.textContent = "Inserisci un indirizzo o delle coordinate qui sopra per ordinare i luoghi dal più vicino al più lontano.";
    } else if (sortMode === "proximity" && lastProximityOrigin) {
      info.textContent = `${list.length} luog${list.length === 1 ? "o" : "hi"} · ordinati dal più vicino al più lontano rispetto a "${lastProximityOrigin.label}"`;
    } else {
      info.textContent = `${list.length} luog${list.length === 1 ? "o" : "hi"} · ${places.filter((p) => !p.deletedAt && p.status === "visited").length} visitati · ${places.filter((p) => !p.deletedAt && p.status === "to_visit").length} da visitare`;
    }

    if (!list.length) {
      grid.innerHTML = "";
      empty.classList.remove("hidden");
      return;
    }
    empty.classList.add("hidden");

    grid.innerHTML = list
      .map((p) => {
        const cover = p.coverPhoto
          ? `<img class="card-cover" data-cover-img src="${escapeHtml(p.coverPhoto)}" alt="${escapeHtml(p.name)}">`
          : `<div class="card-cover-placeholder">Nessuna foto</div>`;
        const statusLabel = p.status === "visited" ? "Visitato" : "Da visitare";
        const tagChips = (p.tags || [])
          .map((tid) => tagById(tid))
          .filter(Boolean)
          .map((t) => `<span class="tag-chip" style="background:${t.color}"><span class="dot"></span>${escapeHtml(t.name)}</span>`)
          .join("");
        const dist = placeDistances[p.id];
        const distHtml = $("sortSelect").value === "proximity" && dist != null
          ? `<div class="card-distance">≈ ${dist < 1 ? Math.round(dist * 1000) + " m" : dist.toFixed(1) + " km"} da ${escapeHtml(lastProximityOrigin.label)}</div>`
          : "";
        return `
        <article class="place-card" data-id="${p.id}">
          <div style="position:relative;">
            ${cover}
            <span class="stamp ${p.status}">${statusLabel}</span>
          </div>
          <div class="card-body">
            <div class="card-title">${escapeHtml(p.name)}</div>
            <div class="card-country">${escapeHtml(p.country)}</div>
            ${p.description ? `<div class="card-desc">${escapeHtml(truncate(p.description, 110))}</div>` : ""}
            ${tagChips ? `<div class="card-tags">${tagChips}</div>` : ""}
            ${distHtml}
          </div>
        </article>`;
      })
      .join("");

    grid.querySelectorAll(".place-card").forEach((card) => {
      card.addEventListener("click", () => openDetail(card.dataset.id));
    });

    grid.querySelectorAll("[data-cover-img]").forEach((img) => {
      img.addEventListener(
        "error",
        function handleBrokenImg() {
          const placeholder = document.createElement("div");
          placeholder.className = "card-cover-placeholder";
          placeholder.textContent = "Immagine non disponibile";
          this.replaceWith(placeholder);
        },
        { once: true }
      );
    });
  }

  function truncate(str, n) {
    return str.length > n ? str.slice(0, n).trim() + "…" : str;
  }

  // ---------- Cestino ----------
  function updateTrashCount() {
    $("trashCount").textContent = places.filter((p) => p.deletedAt).length;
  }

  function renderTrash() {
    const list = places.filter((p) => p.deletedAt).sort((a, b) => new Date(b.deletedAt) - new Date(a.deletedAt));
    const ul = $("trashList");
    if (!list.length) {
      ul.innerHTML = '<p class="field-hint">Il cestino è vuoto.</p>';
      return;
    }
    ul.innerHTML = list
      .map((p) => {
        const deletedDate = new Date(p.deletedAt);
        const daysLeft = TRASH_RETENTION_DAYS - Math.floor((Date.now() - deletedDate.getTime()) / 86400000);
        const thumb = p.coverPhoto
          ? `<img class="trash-thumb" src="${escapeHtml(p.coverPhoto)}" alt="">`
          : `<div class="trash-thumb"></div>`;
        return `
        <li class="trash-item" data-id="${p.id}">
          ${thumb}
          <div class="trash-info">
            <div class="name">${escapeHtml(p.name)}</div>
            <div class="meta">Eliminato il ${deletedDate.toLocaleDateString("it-IT")} · eliminazione definitiva tra ${Math.max(daysLeft, 0)} giorni</div>
          </div>
          <div class="trash-actions">
            <button class="btn btn-small btn-outline" data-action="restore">Ripristina</button>
            <button class="btn btn-small btn-danger" data-action="delete-forever">Elimina definitivamente</button>
          </div>
        </li>`;
      })
      .join("");

    ul.querySelectorAll("[data-action=restore]").forEach((btn) =>
      btn.addEventListener("click", (e) => {
        const id = e.target.closest(".trash-item").dataset.id;
        const place = places.find((p) => p.id === id);
        if (place) {
          place.deletedAt = null;
          saveTags(); savePlaces();
          renderAll();
          showToast("Luogo ripristinato.");
        }
      })
    );
    ul.querySelectorAll("[data-action='delete-forever']").forEach((btn) =>
      btn.addEventListener("click", (e) => {
        const id = e.target.closest(".trash-item").dataset.id;
        askConfirm("Eliminare definitivamente questo luogo? L'azione non è reversibile.", () => {
          places = places.filter((p) => p.id !== id);
          savePlaces();
          renderAll();
          showToast("Luogo eliminato definitivamente.");
        });
      })
    );
  }

  // ---------- Modale: Nuovo / Modifica luogo ----------
  function openPlaceModal(place) {
    editingPlaceId = place ? place.id : null;
    $("placeModalTitle").textContent = place ? "Modifica luogo" : "Nuovo luogo";
    $("placeId").value = place ? place.id : "";
    $("placeName").value = place ? place.name : "";
    $("placeCountry").value = place ? place.country : "";
    $("placeAddress").value = place ? place.address : "";
    $("placeDescription").value = place ? place.description || "" : "";
    $("placeHours").value = place ? place.openingHours || "" : "";
    $("placePrice").value = place ? place.price || "" : "";
    $("coverUrl").value = place && place.coverPhotoType === "url" ? place.coverPhoto : "";
    $("coverFile").value = "";

    coverDataInForm = place && place.coverPhoto ? { type: place.coverPhotoType, value: place.coverPhoto } : { type: null, value: null };
    updateCoverPreview();

    currentStatusInForm = place ? place.status : "to_visit";
    updateStatusSegmented();

    selectedTagIdsInForm = place ? [...(place.tags || [])] : [];
    renderTagPicker();

    $("placeModalOverlay").classList.remove("hidden");
    $("placeName").focus();
  }

  function closePlaceModal() {
    $("placeModalOverlay").classList.add("hidden");
    editingPlaceId = null;
  }

  function updateCoverPreview() {
    const img = $("coverPreview");
    const placeholder = $("coverPlaceholder");
    if (coverDataInForm.value) {
      img.src = coverDataInForm.value;
      img.classList.remove("hidden");
      placeholder.classList.add("hidden");
    } else {
      img.classList.add("hidden");
      placeholder.classList.remove("hidden");
    }
  }

  function updateStatusSegmented() {
    document.querySelectorAll("#statusSegmented .segmented-option").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.value === currentStatusInForm);
    });
  }

  function renderTagPicker() {
    const wrap = $("tagPicker");
    const hint = $("tagPickerHint");
    if (!tags.length) {
      wrap.innerHTML = "";
      hint.classList.remove("hidden");
      return;
    }
    hint.classList.add("hidden");
    wrap.innerHTML = tags
      .map((t) => {
        const active = selectedTagIdsInForm.includes(t.id);
        const disabled = !active && selectedTagIdsInForm.length >= MAX_TAGS_PER_PLACE;
        return `<button type="button" class="tag-pill-toggle ${active ? "active" : ""}" ${disabled ? "disabled style='opacity:.4;cursor:not-allowed;'" : ""} data-tag-id="${t.id}" style="${active ? `background:${t.color};border-color:${t.color};` : ""}">${escapeHtml(t.name)}</button>`;
      })
      .join("");
    wrap.querySelectorAll("[data-tag-id]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const id = btn.dataset.tagId;
        if (selectedTagIdsInForm.includes(id)) {
          selectedTagIdsInForm = selectedTagIdsInForm.filter((t) => t !== id);
        } else {
          if (selectedTagIdsInForm.length >= MAX_TAGS_PER_PLACE) {
            showToast(`Puoi assegnare al massimo ${MAX_TAGS_PER_PLACE} tag.`);
            return;
          }
          selectedTagIdsInForm.push(id);
        }
        renderTagPicker();
      });
    });
  }

  function handlePlaceFormSubmit(e) {
    e.preventDefault();
    const name = $("placeName").value.trim();
    const country = $("placeCountry").value.trim();
    const address = $("placeAddress").value.trim();
    if (!name || !country || !address) {
      showToast("Compila tutti i campi obbligatori.");
      return;
    }

    const payload = {
      name,
      country,
      address,
      description: $("placeDescription").value.trim(),
      openingHours: $("placeHours").value.trim(),
      price: $("placePrice").value.trim(),
      status: currentStatusInForm,
      tags: [...selectedTagIdsInForm],
      coverPhoto: coverDataInForm.value || "",
      coverPhotoType: coverDataInForm.type || "",
    };

    if (editingPlaceId) {
      const idx = places.findIndex((p) => p.id === editingPlaceId);
      if (idx > -1) places[idx] = { ...places[idx], ...payload };
      showToast("Luogo aggiornato.");
    } else {
      places.push({
        id: uid(),
        ...payload,
        dateAdded: new Date().toISOString(),
        deletedAt: null,
      });
      showToast("Luogo aggiunto.");
    }
    savePlaces();
    closePlaceModal();
    renderAll();
  }

  // ---------- Modale: Dettaglio ----------
  function openDetail(id) {
    const p = places.find((pl) => pl.id === id);
    if (!p) return;
    $("detailTitle").textContent = p.name;
    const tagChips = (p.tags || [])
      .map((tid) => tagById(tid))
      .filter(Boolean)
      .map((t) => `<span class="tag-chip" style="background:${t.color}"><span class="dot"></span>${escapeHtml(t.name)}</span>`)
      .join("");
    const cover = p.coverPhoto ? `<img class="detail-cover" src="${escapeHtml(p.coverPhoto)}" alt="${escapeHtml(p.name)}">` : "";
    const statusLabel = p.status === "visited" ? "Visitato" : "Da visitare";

    $("detailBody").innerHTML = `
      ${cover}
      <div class="detail-meta">
        <span><strong>Nazione:</strong> ${escapeHtml(p.country)}</span>
        <span><strong>Stato:</strong> ${statusLabel}</span>
        ${p.openingHours ? `<span><strong>Orari:</strong> ${escapeHtml(p.openingHours)}</span>` : ""}
        ${p.price ? `<span><strong>Prezzo:</strong> ${escapeHtml(p.price)}</span>` : ""}
        <span><strong>Aggiunto il:</strong> ${new Date(p.dateAdded).toLocaleDateString("it-IT")}</span>
      </div>
      ${p.description ? `<p class="detail-desc">${escapeHtml(p.description)}</p>` : ""}
      ${tagChips ? `<div class="detail-tags">${tagChips}</div>` : ""}
      <a class="maps-link" target="_blank" rel="noopener" href="${googleMapsUrl(p)}">📍 Apri in Google Maps</a>
      <div class="detail-actions">
        <button class="btn btn-outline" id="detailEditBtn">Modifica</button>
        <button class="btn btn-danger-outline" id="detailDeleteBtn">Elimina</button>
      </div>
    `;
    $("detailEditBtn").addEventListener("click", () => {
      closeDetail();
      openPlaceModal(p);
    });
    $("detailDeleteBtn").addEventListener("click", () => {
      askConfirm(`Spostare "${p.name}" nel cestino?`, () => {
        p.deletedAt = new Date().toISOString();
        savePlaces();
        closeDetail();
        renderAll();
        showToast("Luogo spostato nel cestino.");
      });
    });
    $("detailModalOverlay").classList.remove("hidden");
  }
  function closeDetail() { $("detailModalOverlay").classList.add("hidden"); }

  // ---------- Gestione tag ----------
  function renderTagManageList() {
    const ul = $("tagManageList");
    if (!tags.length) {
      ul.innerHTML = '<p class="field-hint">Nessun tag creato.</p>';
      return;
    }
    ul.innerHTML = tags
      .map(
        (t) => `
      <li class="tag-manage-item" data-id="${t.id}">
        <input type="color" value="${t.color}" data-role="color">
        <input type="text" value="${escapeHtml(t.name)}" data-role="name">
        <button class="btn btn-small btn-danger-outline" data-role="delete">Elimina</button>
      </li>`
      )
      .join("");

    ul.querySelectorAll(".tag-manage-item").forEach((li) => {
      const id = li.dataset.id;
      li.querySelector("[data-role=name]").addEventListener("change", (e) => {
        const t = tagById(id);
        if (t && e.target.value.trim()) { t.name = e.target.value.trim(); saveTags(); renderAll(); }
      });
      li.querySelector("[data-role=color]").addEventListener("change", (e) => {
        const t = tagById(id);
        if (t) { t.color = e.target.value; saveTags(); renderAll(); }
      });
      li.querySelector("[data-role=delete]").addEventListener("click", () => {
        askConfirm("Eliminare questo tag? Verrà rimosso da tutti i luoghi.", () => {
          tags = tags.filter((t) => t.id !== id);
          places.forEach((p) => { p.tags = (p.tags || []).filter((tid) => tid !== id); });
          activeTagFilters.delete(id);
          saveTags(); savePlaces();
          renderTagManageList();
          renderAll();
          showToast("Tag eliminato.");
        });
      });
    });
  }

  function addTag() {
    const nameInput = $("newTagName");
    const colorInput = $("newTagColor");
    const name = nameInput.value.trim();
    if (!name) { showToast("Inserisci un nome per il tag."); return; }
    if (tags.some((t) => t.name.toLowerCase() === name.toLowerCase())) {
      showToast("Esiste già un tag con questo nome."); return;
    }
    tags.push({ id: "t_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), name, color: colorInput.value });
    saveTags();
    nameInput.value = "";
    colorInput.value = DEFAULT_TAG_COLORS[tags.length % DEFAULT_TAG_COLORS.length];
    renderTagManageList();
    renderAll();
  }

  // ---------- Conferma generica ----------
  let confirmCancelCallback = null;
  function askConfirm(message, onConfirm, onCancel) {
    $("confirmMessage").textContent = message;
    confirmCallback = onConfirm;
    confirmCancelCallback = onCancel || null;
    $("confirmModalOverlay").classList.remove("hidden");
  }

  // ---------- Prossimità ----------
  async function runProximitySearch() {
    const query = $("proximityInput").value.trim();
    if (!query) { showToast("Inserisci un indirizzo o un luogo di riferimento."); return; }
    const status = $("proximityStatus");
    status.textContent = "Ricerca in corso…";
    try {
      let origin = tryParseCoords(query);
      if (!origin) origin = await geocode(query);
      if (!origin) { status.textContent = "Indirizzo non trovato."; return; }
      lastProximityOrigin = { ...origin, label: query };

      placeDistances = {};
      const withCoords = places.filter((p) => !p.deletedAt && getPlaceCoords(p));
      withCoords.forEach((p) => {
        placeDistances[p.id] = haversineKm(origin, getPlaceCoords(p));
      });

      // Geocodifica anche i luoghi senza coordinate esplicite (indirizzo testuale), in sequenza per rispettare i limiti d'uso.
      const withoutCoords = places.filter((p) => !p.deletedAt && !getPlaceCoords(p));
      for (const p of withoutCoords) {
        try {
          const c = await geocode(`${p.address}, ${p.country}`);
          if (c) placeDistances[p.id] = haversineKm(origin, c);
          await new Promise((r) => setTimeout(r, 350)); // gentile verso il servizio di geocoding gratuito
        } catch (e) { /* ignora singolo fallimento */ }
      }

      status.textContent = `✓ Luoghi ordinati dal più vicino al più lontano rispetto a "${query}".`;
      $("sortSelect").value = "proximity";
      renderGrid();
    } catch (err) {
      console.error(err);
      status.textContent = "Errore durante la ricerca. Riprova.";
    }
  }

  // ---------- Copertina: caricamento file ----------
  function handleCoverFile(file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      coverDataInForm = { type: "upload", value: reader.result };
      $("coverUrl").value = "";
      updateCoverPreview();
    };
    reader.readAsDataURL(file);
  }

  // ---------- Google Drive: autenticazione ----------
  function isClientIdConfigured() {
    return GOOGLE_CLIENT_ID && !GOOGLE_CLIENT_ID.startsWith("INSERISCI_QUI");
  }

  function setSyncUI(state, text) {
    // state: 'signed-out' | 'ok' | 'syncing' | 'error'
    const signInBtn = $("btnGoogleSignIn");
    const statusWrap = $("syncStatusWrap");
    const dot = $("syncDot");
    const txt = $("syncText");
    if (state === "signed-out") {
      signInBtn.classList.remove("hidden");
      statusWrap.classList.add("hidden");
      return;
    }
    signInBtn.classList.add("hidden");
    statusWrap.classList.remove("hidden");
    dot.className = "sync-dot" + (state === "syncing" ? " syncing" : state === "error" ? " error" : "");
    txt.textContent = text || (state === "syncing" ? "Sincronizzazione…" : state === "error" ? "Errore di sync" : "Sincronizzato con Drive");
  }

  function initGoogleAuth() {
    if (!isClientIdConfigured()) {
      $("btnGoogleSignIn").title = "Devi prima configurare GOOGLE_CLIENT_ID in script.js — vedi README.md";
      return;
    }
    if (!window.google || !google.accounts || !google.accounts.oauth2) {
      // Lo script di Google potrebbe non essere ancora pronto: riprova tra poco.
      setTimeout(initGoogleAuth, 400);
      return;
    }
    tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: GOOGLE_CLIENT_ID,
      scope: DRIVE_SCOPE,
      callback: handleTokenResponse,
      error_callback: (err) => {
        console.error("Errore di autenticazione Google:", err);
        showToast("Accesso a Google annullato o non riuscito.");
      },
    });
    // Prova un accesso "silenzioso": se l'utente ha già autorizzato l'app in
    // precedenza ed è ancora loggato in Google in questo browser, evitiamo
    // di chiedergli di nuovo il consenso ad ogni apertura della pagina.
    tokenClient.requestAccessToken({ prompt: "none" });
  }

  function handleTokenResponse(resp) {
    if (!resp || resp.error) {
      // Login silenzioso non disponibile: mostriamo semplicemente il pulsante di accesso.
      setSyncUI("signed-out");
      return;
    }
    accessToken = resp.access_token;
    setSyncUI("syncing", "Connessione a Drive…");
    connectToDrive();
  }

  function signInWithGoogle() {
    if (!isClientIdConfigured()) {
      showToast("Sincronizzazione non ancora configurata: apri il README per i passaggi su Google Cloud.");
      return;
    }
    if (!tokenClient) { showToast("Google non è ancora pronto, riprova tra un secondo."); return; }
    tokenClient.requestAccessToken({ prompt: "consent" });
  }

  function signOutFromGoogle() {
    if (accessToken && window.google && google.accounts && google.accounts.oauth2) {
      google.accounts.oauth2.revoke(accessToken, () => {});
    }
    accessToken = null;
    driveFileId = null;
    clearTimeout(syncDebounceTimer);
    setSyncUI("signed-out");
    showToast("Disconnesso da Google Drive. I dati restano salvati solo su questo dispositivo.");
  }

  // ---------- Google Drive: lettura/scrittura file ----------
  function driveHeaders(extra) {
    return Object.assign({ Authorization: "Bearer " + accessToken }, extra || {});
  }

  async function driveFindFile() {
    const url =
      "https://www.googleapis.com/drive/v3/files" +
      "?spaces=appDataFolder&fields=files(id,modifiedTime)&q=" +
      encodeURIComponent(`name='${DRIVE_FILE_NAME}'`);
    const res = await fetch(url, { headers: driveHeaders() });
    if (!res.ok) throw new Error("Impossibile leggere Google Drive (HTTP " + res.status + ")");
    const data = await res.json();
    return data.files && data.files.length ? data.files[0] : null;
  }

  async function driveDownloadFile(fileId) {
    const res = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, {
      headers: driveHeaders(),
    });
    if (!res.ok) throw new Error("Impossibile scaricare i dati da Drive (HTTP " + res.status + ")");
    return res.json();
  }

  async function driveCreateFile(payload) {
    const boundary = "atlante-boundary";
    const metadata = { name: DRIVE_FILE_NAME, parents: ["appDataFolder"] };
    const body =
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n` +
      `--${boundary}\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(payload)}\r\n` +
      `--${boundary}--`;
    const res = await fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id", {
      method: "POST",
      headers: driveHeaders({ "Content-Type": `multipart/related; boundary=${boundary}` }),
      body,
    });
    if (!res.ok) throw new Error("Impossibile creare il file su Drive (HTTP " + res.status + ")");
    const data = await res.json();
    return data.id;
  }

  async function driveUpdateFile(fileId, payload) {
    const res = await fetch(`https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=media`, {
      method: "PATCH",
      headers: driveHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error("Impossibile aggiornare il file su Drive (HTTP " + res.status + ")");
  }

  async function connectToDrive() {
    try {
      const existing = await driveFindFile();
      if (!existing) {
        // Prima connessione: creiamo il file cloud a partire dai dati locali attuali.
        driveFileId = await driveCreateFile({ places, tags, updatedAt: new Date().toISOString() });
        setSyncUI("ok", "Backup su Drive creato");
        showToast("I tuoi dati locali sono stati caricati su Google Drive.");
        return;
      }
      driveFileId = existing.id;
      const hasLocalData = places.length > 0 || tags.length > 0;
      if (!hasLocalData) {
        // Nessun dato locale: scarichiamo direttamente quello che c'è nel cloud.
        await pullFromDrive();
        setSyncUI("ok");
        return;
      }
      // Ci sono sia dati locali sia dati cloud: chiediamo all'utente quali tenere,
      // per evitare di perdere in silenzio uno dei due set di dati.
      setSyncUI("ok", "In attesa della tua scelta…");
      askConfirm(
        "Ho trovato sia dati salvati su questo dispositivo sia dati già presenti su Google Drive.\n\n" +
        "Conferma = usa i dati di Google Drive (sovrascrive quelli locali).\n" +
        "Annulla = mantieni i dati di questo dispositivo e li carico su Drive (sovrascrive quelli cloud).",
        async () => {
          await pullFromDrive();
          setSyncUI("ok");
        },
        async () => {
          await pushToDrive();
        }
      );
    } catch (err) {
      console.error(err);
      setSyncUI("error", "Errore di connessione a Drive");
      showToast("Non sono riuscito a collegarmi a Google Drive: " + err.message);
    }
  }

  async function pullFromDrive() {
    if (!driveFileId) return;
    isPulling = true;
    const data = await driveDownloadFile(driveFileId);
    places = Array.isArray(data.places) ? data.places : [];
    tags = Array.isArray(data.tags) ? data.tags : [];
    savePlaces();
    saveTags();
    isPulling = false;
    renderAll();
    showToast("Dati scaricati da Google Drive.");
  }

  async function pushToDrive() {
    if (!accessToken) return;
    try {
      isPushing = true;
      setSyncUI("syncing");
      if (!driveFileId) {
        driveFileId = await driveCreateFile({ places, tags, updatedAt: new Date().toISOString() });
      } else {
        await driveUpdateFile(driveFileId, { places, tags, updatedAt: new Date().toISOString() });
      }
      setSyncUI("ok", "Sincronizzato con Drive");
    } catch (err) {
      console.error(err);
      setSyncUI("error", "Errore di sync — riprovo al prossimo salvataggio");
    } finally {
      isPushing = false;
    }
  }

  function scheduleCloudPush() {
    if (!accessToken || isPulling) return; // non collegati a Drive, o dati appena scaricati: niente push
    clearTimeout(syncDebounceTimer);
    setSyncUI("syncing");
    syncDebounceTimer = setTimeout(pushToDrive, SYNC_DEBOUNCE_MS);
  }

  // ---------- Render globale ----------
  function renderAll() {
    renderCountryFilterOptions();
    renderTagFilterList();
    updateTrashCount();
    renderGrid();
  }

  // ---------- Event bindings ----------
  function bindEvents() {
    $("btnGoogleSignIn").addEventListener("click", signInWithGoogle);
    $("btnGoogleSignOut").addEventListener("click", () => {
      askConfirm("Disconnettersi da Google Drive? I dati resteranno salvati solo su questo dispositivo.", signOutFromGoogle);
    });

    $("btnNewPlace").addEventListener("click", () => openPlaceModal(null));
    $("placeModalClose").addEventListener("click", closePlaceModal);
    $("placeCancelBtn").addEventListener("click", closePlaceModal);
    $("placeForm").addEventListener("submit", handlePlaceFormSubmit);

    $("coverUrl").addEventListener("input", (e) => {
      const val = e.target.value.trim();
      coverDataInForm = val ? { type: "url", value: val } : { type: null, value: null };
      $("coverFile").value = "";
      updateCoverPreview();
    });
    $("coverFile").addEventListener("change", (e) => handleCoverFile(e.target.files[0]));

    document.querySelectorAll("#statusSegmented .segmented-option").forEach((btn) => {
      btn.addEventListener("click", () => {
        currentStatusInForm = btn.dataset.value;
        updateStatusSegmented();
      });
    });

    $("detailModalClose").addEventListener("click", closeDetail);

    $("btnTags").addEventListener("click", () => {
      renderTagManageList();
      $("tagsModalOverlay").classList.remove("hidden");
    });
    $("tagsModalClose").addEventListener("click", () => $("tagsModalOverlay").classList.add("hidden"));
    $("btnAddTag").addEventListener("click", addTag);
    $("newTagName").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); addTag(); } });

    $("btnTrash").addEventListener("click", () => {
      renderTrash();
      $("trashModalOverlay").classList.remove("hidden");
    });
    $("trashModalClose").addEventListener("click", () => $("trashModalOverlay").classList.add("hidden"));
    $("btnEmptyTrash").addEventListener("click", () => {
      if (!places.some((p) => p.deletedAt)) { showToast("Il cestino è già vuoto."); return; }
      askConfirm("Svuotare definitivamente il cestino? L'azione non è reversibile.", () => {
        places = places.filter((p) => !p.deletedAt);
        savePlaces();
        renderTrash();
        renderAll();
        showToast("Cestino svuotato.");
      });
    });

    $("confirmCancelBtn").addEventListener("click", () => {
      $("confirmModalOverlay").classList.add("hidden");
      const cancelFn = confirmCancelCallback;
      confirmCallback = null;
      confirmCancelCallback = null;
      if (cancelFn) cancelFn();
    });
    $("confirmOkBtn").addEventListener("click", () => {
      $("confirmModalOverlay").classList.add("hidden");
      if (confirmCallback) confirmCallback();
      confirmCallback = null;
      confirmCancelCallback = null;
    });

    // Chiudi modali cliccando sull'overlay
    document.querySelectorAll(".modal-overlay").forEach((ov) => {
      ov.addEventListener("click", (e) => { if (e.target === ov) ov.classList.add("hidden"); });
    });

    $("searchInput").addEventListener("input", renderGrid);
    $("countryFilter").addEventListener("change", renderGrid);
    $("statusFilter").addEventListener("change", renderGrid);
    $("btnClearFilters").addEventListener("click", () => {
      $("countryFilter").value = "";
      $("statusFilter").value = "";
      activeTagFilters.clear();
      renderTagFilterList();
      renderGrid();
    });
    $("btnToggleFilters").addEventListener("click", () => $("filtersPanel").classList.toggle("hidden"));

    $("sortSelect").addEventListener("change", () => {
      const isProximity = $("sortSelect").value === "proximity";
      $("proximityRow").classList.toggle("hidden", !isProximity);
      if (isProximity) {
        $("proximityInput").focus();
        // Se non abbiamo ancora un indirizzo di riferimento, lo chiediamo subito.
        if (!lastProximityOrigin) {
          const suggestion = window.prompt(
            "Ordina per vicinanza: inserisci un indirizzo, il nome di un luogo, oppure delle coordinate (es. 45.4642, 9.1900)."
          );
          if (suggestion && suggestion.trim()) {
            $("proximityInput").value = suggestion.trim();
            runProximitySearch();
          }
        }
      }
      renderGrid();
    });
    $("btnProximitySearch").addEventListener("click", runProximitySearch);
    $("proximityInput").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); runProximitySearch(); } });
  }

  // ---------- Avvio ----------
  function init() {
    try {
      loadData();
      purgeExpiredTrash();
      bindEvents();
      renderAll();
      setSyncUI("signed-out");
      initGoogleAuth();
    } catch (err) {
      console.error("Errore durante l'avvio dell'app:", err);
      showToast("Errore all'avvio: apri la console del browser (F12) per i dettagli.");
    }
  }

  document.addEventListener("DOMContentLoaded", init);
})();
