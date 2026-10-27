  function bind() {
    if (bound) return;
    bound = true;
    bindShell();
    const back = document.getElementById("btnChatBack");
    if (back) back.addEventListener("click", () => closeThreadLayer());
    const form = document.getElementById("chatForm");
    if (form) {
      form.addEventListener("submit", (e) => {
        e.preventDefault();
        sendChatMessage();
      });
    }