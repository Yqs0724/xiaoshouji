  function readNotes() {
    try {
      const raw = JSON.parse(localStorage.getItem(NOTE_KEY) || "{}");
      return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
    } catch {
      return {};
    }
  }

  function readNote(sessId) {
    const id = String(sessId || "daily");
    return String(readNotes()[id] || "").trim();
  }

  function writeNote(sessId, name) {
    const id = String(sessId || "daily");
    const all = readNotes();
    const t = String(name || "").trim().slice(0, 32);
    if (!t) delete all[id];
    else all[id] = t;
    localStorage.setItem(NOTE_KEY, JSON.stringify(all));
  }

  /** 列表/顶栏显示名：备注优先，否则小屋称呼 */
  function displayPeerName(sessId) {
    return readNote(sessId || "daily") || deps.getPeerName() || "家机";
  }

  function refreshPeerLabels() {
    const name = displayPeerName();
    const note = readNote("daily");
    const sess = document.getElementById("chatSessName");
    if (sess) sess.textContent = name;
    const contact = document.getElementById("chatContactName");
    if (contact) contact.textContent = name;
    const peer = document.getElementById("chatPeerName");
    if (peer && !peer.classList.contains("is-typing")) peer.textContent = name;
    const peerTitle = document.getElementById("chatPeerPageTitle");
    if (peerTitle) peerTitle.textContent = name;
    const profileName = document.getElementById("chatProfileName");
    if (profileName) profileName.textContent = name;
    const clearPeer = document.getElementById("chatClearPeerName");
    if (clearPeer) clearPeer.textContent = name;
    const noteVal = document.getElementById("chatPeerNoteVal");
    if (noteVal) noteVal.textContent = note || "未设置";
    const noteInput = document.getElementById("chatNoteInput");
    if (noteInput && document.getElementById("chatOvNote") &&
        !document.getElementById("chatOvNote").hidden) {
      /* 编辑页打开时不抢输入 */
    }
  }

  function readPins() {
    try {
      const raw = JSON.parse(localStorage.getItem(PIN_KEY) || "[]");
      return Array.isArray(raw) ? raw.map(String).filter(Boolean) : [];
    } catch {
      return [];
    }
  }