  function bind() {
    if (bound) return;
    bound = true;
    bindShell();
    const back = document.getElementById("btnChatBack");
    if (back) {
      back.addEventListener("click", () => {
        if (multiMode) {
          exitMultiMode();
          return;
        }
        closeThreadLayer();
      });
    }
    const thread = document.getElementById("chatThread");
    if (thread) {
      thread.addEventListener(
        "click",
        (e) => {
          if (!multiMode) return;
          const row = e.target.closest(".wx-row[data-msg-id]");
          if (!row) return;
          e.preventDefault();
          e.stopPropagation();
          toggleMultiId(row.dataset.msgId);
        },
        true
      );
    }
    const multiCancel = document.getElementById("chatMultiCancel");
    if (multiCancel) multiCancel.addEventListener("click", () => exitMultiMode());
    const multiFwd = document.getElementById("chatMultiFwd");
    if (multiFwd) multiFwd.addEventListener("click", () => multiForwardUi());
    const multiDel = document.getElementById("chatMultiDel");
    if (multiDel) multiDel.addEventListener("click", () => multiDeleteUi());
    const form = document.getElementById("chatForm");
    if (form) {
      form.addEventListener("submit", (e) => {
        e.preventDefault();
        if (multiMode) return;
        sendChatMessage();
      });
    }