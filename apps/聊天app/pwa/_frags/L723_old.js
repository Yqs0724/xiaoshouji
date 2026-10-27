    const hold = document.getElementById("btnChatHold");
    if (hold) {
      hold.addEventListener("contextmenu", (e) => e.preventDefault());
      hold.addEventListener("pointerdown", () => {
        hold.classList.add("is-pressing");
        hold.textContent = "松开 结束";
      });
      const endHold = () => {
        if (!hold.classList.contains("is-pressing")) return;
        hold.classList.remove("is-pressing");
        hold.textContent = "按住 说话";
        setChatErr("语音消息未开");
      };
      hold.addEventListener("pointerup", endHold);
      hold.addEventListener("pointerleave", endHold);
      hold.addEventListener("pointercancel", endHold);
    }